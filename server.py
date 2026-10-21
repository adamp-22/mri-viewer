#!/usr/bin/env python3
"""Local DICOM viewer server.

Reads a DICOMDIR-style study folder (the MicroDicom / Philips CD layout with an
IMAGES/ directory) and serves it to a browser UI on localhost.  Pixel data is
sent to the client as raw stored 16-bit values; windowing, zoom and pan all
happen in the browser, so nothing is re-quantised on the way out.

Nothing leaves the machine: the socket is bound to 127.0.0.1.
"""

import argparse
import io
import json
import os
import re
import socket
import sys
import threading
import time
import webbrowser
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pydicom

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
GROUNDING = os.path.join(HERE, "grounding")
GROUNDING_REPORT = os.path.join(GROUNDING, "grounded_report.json")
GROUNDING_ANNOTATIONS = os.path.join(GROUNDING, "annotations.json")
GROUNDING_SOURCE_IMAGE = os.path.join(GROUNDING, "report.png")

# ----------------------------------------------------------------------------
# study indexing
# ----------------------------------------------------------------------------


def _num(v, default=None):
    """DICOM numbers arrive as DSfloat / IS / MultiValue; flatten to a float."""
    if v is None:
        return default
    if isinstance(v, (list, tuple)) or type(v).__name__ == "MultiValue":
        v = v[0] if len(v) else None
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _str(v, default=""):
    if v is None:
        return default
    return str(v).strip()


class Study:
    """An indexed study: series metadata plus a decoded-slice cache."""

    def __init__(self, root, cache_slices=140):
        self.root = os.path.abspath(root)
        self.images_dir = self._find_images_dir(self.root)
        self.patient = {}
        self.series = []           # list of dicts, sorted for display
        self.by_uid = {}           # series key -> series dict
        self.report = None         # path of an encapsulated PDF, if present
        self._cache = OrderedDict()
        self._cache_max = cache_slices
        self._lock = threading.Lock()
        self._prefetch_gen = 0
        self._index()

    # -- discovery -----------------------------------------------------------

    @staticmethod
    def _find_images_dir(root):
        for cand in (os.path.join(root, "IMAGES"), os.path.join(root, "images"), root):
            if os.path.isdir(cand):
                names = os.listdir(cand)
                if any(not n.startswith(".") and os.path.isfile(os.path.join(cand, n))
                       for n in names):
                    return cand
        return root

    def _files(self):
        out = []
        for name in os.listdir(self.images_dir):
            if name.startswith(".") or name in ("DICOMDIR", "readme.txt"):
                continue
            path = os.path.join(self.images_dir, name)
            if os.path.isfile(path):
                out.append(path)

        def key(p):
            m = re.search(r"(\d+)\s*$", os.path.basename(p))
            return (0, int(m.group(1))) if m else (1, os.path.basename(p))

        return sorted(out, key=key)

    def _index(self):
        t0 = time.time()
        files = self._files()
        groups = {}
        for path in files:
            try:
                d = pydicom.dcmread(path, stop_before_pixels=True, force=True)
            except Exception:
                continue
            if not getattr(d, "SOPClassUID", None):
                continue

            # Encapsulated PDF (the radiology report) rides along as its own series.
            if str(d.SOPClassUID) == "1.2.840.10008.5.1.4.1.1.104.1":
                self.report = path
                continue
            if not hasattr(d, "Rows"):
                continue

            if not self.patient:
                self.patient = {
                    "name": _str(getattr(d, "PatientName", "")).replace("^", " ").strip(),
                    "id": _str(getattr(d, "PatientID", "")),
                    "birth": _str(getattr(d, "PatientBirthDate", "")),
                    "sex": _str(getattr(d, "PatientSex", "")),
                    "studyDate": _str(getattr(d, "StudyDate", "")),
                    "studyTime": _str(getattr(d, "StudyTime", ""))[:6],
                    "studyDesc": _str(getattr(d, "StudyDescription", "")),
                    "institution": _str(getattr(d, "InstitutionName", "")),
                    "manufacturer": (_str(getattr(d, "Manufacturer", "")) + " " +
                                     _str(getattr(d, "ManufacturerModelName", ""))).strip(),
                    "fieldStrength": _num(getattr(d, "MagneticFieldStrength", None)),
                    "bodyPart": _str(getattr(d, "BodyPartExamined", "")),
                }

            uid = _str(getattr(d, "SeriesInstanceUID", "")) or "s%s" % getattr(d, "SeriesNumber", 0)
            g = groups.setdefault(uid, {"slices": [], "head": d})
            g["slices"].append((path, d))

        for uid, g in groups.items():
            head = g["head"]
            iop = [_num(x, 0.0) for x in (getattr(head, "ImageOrientationPatient", None) or [])]
            normal = None
            if len(iop) == 6:
                r, c = np.array(iop[:3]), np.array(iop[3:])
                normal = np.cross(r, c)

            def sort_key(item):
                _p, dd = item
                ipp = getattr(dd, "ImagePositionPatient", None)
                pos = None
                if ipp is not None and normal is not None and len(ipp) == 3:
                    pos = float(np.dot(normal, np.array([_num(x, 0.0) for x in ipp])))
                inst = _num(getattr(dd, "InstanceNumber", None), 0.0)
                return (inst, pos if pos is not None else 0.0)

            g["slices"].sort(key=sort_key)

            slices = []
            for path, dd in g["slices"]:
                ipp = getattr(dd, "ImagePositionPatient", None)
                slices.append({
                    "file": os.path.basename(path),
                    "path": path,
                    "rows": int(getattr(dd, "Rows", 0)),
                    "cols": int(getattr(dd, "Columns", 0)),
                    "slope": _num(getattr(dd, "RescaleSlope", None), 1.0),
                    "intercept": _num(getattr(dd, "RescaleIntercept", None), 0.0),
                    "instance": _num(getattr(dd, "InstanceNumber", None), 0),
                    "loc": _num(getattr(dd, "SliceLocation", None)),
                    "ipp": [_num(x, 0.0) for x in ipp] if ipp is not None and len(ipp) == 3 else None,
                })

            spacing = getattr(head, "PixelSpacing", None)
            desc = _str(getattr(head, "SeriesDescription", "")) or \
                _str(getattr(head, "ProtocolName", "")) or "Series"
            self.series.append({
                "uid": uid,
                "number": int(_num(getattr(head, "SeriesNumber", None), 0)),
                "desc": re.sub(r"_recon$", "", desc),
                "modality": _str(getattr(head, "Modality", "MR")),
                "count": len(slices),
                "rows": slices[0]["rows"], "cols": slices[0]["cols"],
                "wc": _num(getattr(head, "WindowCenter", None), 0.0),
                "ww": _num(getattr(head, "WindowWidth", None), 0.0),
                "bitsStored": int(_num(getattr(head, "BitsStored", None), 16)),
                "spacing": [_num(spacing[0], 1.0), _num(spacing[1], 1.0)] if spacing is not None and len(spacing) == 2 else None,
                "thickness": _num(getattr(head, "SliceThickness", None)),
                "gap": _num(getattr(head, "SpacingBetweenSlices", None)),
                "tr": _num(getattr(head, "RepetitionTime", None)),
                "te": _num(getattr(head, "EchoTime", None)),
                "flip": _num(getattr(head, "FlipAngle", None)),
                "orientation": self._orientation_label(iop),
                "iop": iop if len(iop) == 6 else None,
                "slices": slices,
            })

        self.series.sort(key=lambda s: (s["number"], s["desc"]))
        self.by_uid = {s["uid"]: s for s in self.series}
        self.index_time = time.time() - t0

    @staticmethod
    def _orientation_label(iop):
        """Name the acquisition plane from the direction cosines."""
        if len(iop) != 6:
            return ""
        r, c = np.array(iop[:3]), np.array(iop[3:])
        n = np.cross(r, c)
        axis = int(np.argmax(np.abs(n)))
        base = ["Sagittal", "Coronal", "Axial"][axis]
        # Off-axis by more than ~12 degrees reads as an oblique acquisition.
        if abs(n[axis]) < 0.978:
            base = "Oblique " + base.lower()
        return base

    # -- pixel access --------------------------------------------------------

    def pixels(self, uid, idx):
        """Decoded stored-value array for one slice, LRU-cached."""
        key = (uid, idx)
        with self._lock:
            hit = self._cache.get(key)
            if hit is not None:
                self._cache.move_to_end(key)
                return hit

        s = self.by_uid.get(uid)
        if s is None:
            raise KeyError("series %r" % uid)
        if not 0 <= idx < s["count"]:
            raise IndexError("slice %d outside series %s (0..%d)" % (idx, uid, s["count"] - 1))
        path = s["slices"][idx]["path"]
        arr = pydicom.dcmread(path).pixel_array
        if arr.dtype != np.uint16:
            arr = arr.astype(np.uint16, copy=False) if arr.min() >= 0 else \
                (arr.astype(np.int32) - int(arr.min())).astype(np.uint16)
        arr = np.ascontiguousarray(arr)

        with self._lock:
            self._cache[key] = arr
            self._cache.move_to_end(key)
            while len(self._cache) > self._cache_max:
                self._cache.popitem(last=False)
        return arr

    def prefetch(self, uid, start=0):
        """Warm the cache for a series in the background, nearest slices first."""
        self._prefetch_gen += 1
        gen = self._prefetch_gen
        s = self.by_uid.get(uid)
        if not s:
            return

        def work():
            n = s["count"]
            order = sorted(range(n), key=lambda i: abs(i - start))
            for i in order[:self._cache_max]:
                if gen != self._prefetch_gen:
                    return
                try:
                    self.pixels(uid, i)
                except Exception:
                    pass

        threading.Thread(target=work, daemon=True).start()

    def manifest(self):
        out = {
            "patient": self.patient,
            "root": self.root,
            "series": [],
            "hasReport": bool(self.report),
            "hasGrounding": os.path.isfile(GROUNDING_REPORT),
            "hasFindingsReportImage": os.path.isfile(GROUNDING_SOURCE_IMAGE),
        }
        for s in self.series:
            d = {k: v for k, v in s.items() if k != "slices"}
            d["slices"] = [{k: v for k, v in sl.items() if k != "path"} for sl in s["slices"]]
            out["series"].append(d)
        return out


# ----------------------------------------------------------------------------
# http
# ----------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    study = None
    server_version = "MRIViewer/1.0"

    def log_message(self, *a):
        pass  # keep the console clean; errors still surface via send_error

    def _send(self, body, ctype="application/octet-stream", cache=True):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the browser cancelled a prefetch; not an error

    def _query(self):
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        return {k: v[0] for k, v in q.items()}

    def do_GET(self):
        from urllib.parse import urlparse, unquote
        path = urlparse(self.path).path

        try:
            if path == "/" or path == "/index.html":
                return self._static("index.html", "text/html; charset=utf-8", cache=False)
            if path in ("/app.js", "/style.css"):
                ctype = "text/javascript" if path.endswith(".js") else "text/css"
                return self._static(path[1:], ctype + "; charset=utf-8", cache=False)

            if path == "/api/study":
                body = json.dumps(self.study.manifest()).encode()
                return self._send(body, "application/json", cache=False)

            if path == "/api/grounding":
                if not os.path.isfile(GROUNDING_REPORT):
                    return self.send_error(404, "no grounded findings are installed")
                with open(GROUNDING_REPORT, "r", encoding="utf-8") as f:
                    payload = json.load(f)
                if os.path.isfile(GROUNDING_ANNOTATIONS):
                    with open(GROUNDING_ANNOTATIONS, "r", encoding="utf-8") as f:
                        payload["viewer_annotations"] = json.load(f)
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                return self._send(body, "application/json; charset=utf-8", cache=False)

            if path == "/api/slice":
                q = self._query()
                arr = self.study.pixels(q["series"], int(q["i"]))
                return self._send(arr.astype("<u2", copy=False).tobytes())

            if path == "/api/prefetch":
                q = self._query()
                self.study.prefetch(q["series"], int(q.get("i", 0)))
                return self._send(b"{}", "application/json", cache=False)

            if path == "/report.pdf":
                if not self.study.report:
                    return self.send_error(404, "no report in this study")
                d = pydicom.dcmread(self.study.report)
                return self._send(bytes(d.EncapsulatedDocument), "application/pdf")

            if path == "/grounding/report.png":
                if not os.path.isfile(GROUNDING_SOURCE_IMAGE):
                    return self.send_error(404, "no findings-report image is installed")
                with open(GROUNDING_SOURCE_IMAGE, "rb") as f:
                    return self._send(f.read(), "image/png")

            self.send_error(404, "not found: %s" % unquote(path))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except KeyError as e:
            self.send_error(400, "bad request: missing %s" % e)
        except (IndexError, ValueError) as e:
            self.send_error(404, str(e))
        except Exception as e:
            self.send_error(500, "%s: %s" % (type(e).__name__, e))

    def _static(self, name, ctype, cache=True):
        p = os.path.join(STATIC, name)
        if not os.path.isfile(p):
            return self.send_error(404, "missing static file %s" % name)
        with open(p, "rb") as f:
            self._send(f.read(), ctype, cache=cache)


def free_port(preferred):
    for port in [preferred] + list(range(preferred + 1, preferred + 40)):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("no free port near %d" % preferred)


def main():
    ap = argparse.ArgumentParser(description="Serve a DICOM study to a local browser viewer.")
    default_root = os.environ.get("MRI_ROOT") or os.path.join(os.path.dirname(HERE), "MRI")
    ap.add_argument("root", nargs="?", default=default_root,
                    help="study folder (the one containing IMAGES/); default: %s" % default_root)
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(args.root):
        raise SystemExit("not a folder: %s" % args.root)

    print("Indexing %s ..." % args.root)
    study = Study(args.root)
    if not study.series:
        raise SystemExit("no DICOM images found under %s" % args.root)
    print("  %d series, %d images in %.1fs"
          % (len(study.series), sum(s["count"] for s in study.series), study.index_time))
    for s in study.series:
        print("   %-5s %-38s %3d x %dx%d  %s"
              % (s["number"], s["desc"][:38], s["count"], s["rows"], s["cols"], s["orientation"]))
    if study.report:
        print("   PDF   referral / request document")
    if os.path.isfile(GROUNDING_REPORT):
        print("   JSON  grounded findings + viewer labels")

    Handler.study = study
    port = free_port(args.port)
    url = "http://127.0.0.1:%d/" % port
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    study.prefetch(study.series[0]["uid"], 0)

    print("\n  Viewer ready:  %s" % url)
    print("  Press Ctrl+C to stop.\n")
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
