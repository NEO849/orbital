#!/usr/bin/env python3
"""AOS-1 Observatory — Leak-Scanner (P4.1 Hard-Gate vor jedem Push).

Scannt alle NICHT-gitignorierten Dateien unter aos-observatory/ auf private
Marker (absolute Home-Pfade, Betreiber-IP, E-Mail, lokale Override-Datei-Inhalte).
Exit 0 = sauber, Exit 1 = Fund(e). Gedacht als Vorstufe zu adversarieller
Validierung + menschlicher Freigabe — ersetzt diese NICHT.

    python3 tools/scan_private.py            # scannt das aos-observatory-Repo
    python3 tools/scan_private.py <dir>      # anderer Pfad
"""
import os
import re
import sys
import subprocess

# GENERISCHE Muster (sicher mitzuliefern — verraten nichts Betreiber-Spezifisches).
# Betreiber-SPEZIFISCHE Marker (echte Namen/IP/Mottos) stehen NICHT hier, sondern in
# der gitignorierten tools/scan_deny.local.txt — sonst waere die Denylist selbst ein
# Leak (sie wuerde genau die zu schuetzenden Namen/IP im Klartext publizieren).
PATTERNS = [
    # (a) absolute Home-/System-Pfade, die einen Betreiber verraten
    (r"/root\b", "absoluter Pfad (/root)"),
    (r"/home/[A-Za-z0-9._-]+", "absoluter Home-Pfad (/home/<user>)"),
    (r"/Users/[A-Za-z0-9._-]+", "absoluter Home-Pfad (/Users/<user>)"),
    # (b) private IP-Bereiche: Tailscale 100.64/10, RFC1918
    (r"\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b", "Tailscale-100.64/10-Adresse"),
    (r"\b192\.168\.\d{1,3}\.\d{1,3}\b", "private IP (192.168/16)"),
    (r"\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b", "private IP (172.16/12)"),
    # (c) Memory-DATEINAME <typ>_<slug>.md (three.js "project_vertex" faellt NICHT drunter)
    (r"\b(feedback|project|reference|profile|user)_[a-z0-9_]{3,}\.md\b", "Memory-Datei"),
]


def _load_local_deny(script_dir):
    """Betreiber-spezifische Zusatz-Muster aus gitignored scan_deny.local.txt (eine
    Regex je Zeile, # = Kommentar). Fehlt die Datei -> nur generische Muster."""
    out = []
    p = os.path.join(script_dir, "scan_deny.local.txt")
    try:
        with open(p, encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if ln and not ln.startswith("#"):
                    out.append((ln, "operator-spezifischer Marker (lokale Denylist)"))
    except OSError:
        pass
    return out


# Hinweis: der String "aos.local.json" ist KEIN Leak — der oeffentliche Code muss
# die (gitignorierte) Override-Datei beim Namen laden. Nur ihr INHALT ist privat.
# Grenzen (bewusst): keine Binaer-/EXIF-Pruefung, kein IPv6, keine Hostnamen.
# Der Scanner ist ein NETZ, kein Beweis -> immer + adversarielle Validierung + Freigabe.
# Dateien, in denen ein Treffer ERLAUBT ist (dokumentieren das Verbot selbst).
ALLOW_FILES = {".gitignore", "tools/scan_private.py"}
# Nur Textdateien dieser Endungen scannen.
TEXT_EXT = {".py", ".js", ".html", ".css", ".json", ".jsonl", ".md", ".txt", ".sh", ".yml", ".yaml", ""}


def _ignored(root, rel):
    """git check-ignore -> True, wenn die Datei gitignoriert ist (nicht publiziert)."""
    try:
        r = subprocess.run(["git", "-C", root, "check-ignore", "-q", rel],
                           capture_output=True)
        return r.returncode == 0
    except OSError:
        return False


def scan(root):
    root = os.path.abspath(root)
    hits = []
    # case-INSENSITIV: ein Marker in GROSS-/Misch-Schreibung (oft in Kommentaren) muss auch
    # dann greifen, wenn die Denylist ihn klein fuehrt (Lehre: ein case-sensitiver Grep verfehlt ihn).
    compiled = [(re.compile(p, re.IGNORECASE), why) for p, why in PATTERNS]
    # Betreiber-spezifische Zusatz-Muster (gitignored) dazuladen
    for p, why in _load_local_deny(os.path.dirname(os.path.abspath(__file__))):
        try:
            compiled.append((re.compile(p, re.IGNORECASE), why))
        except re.error:
            pass
    for dirpath, dirs, files in os.walk(root):
        # .git nie scannen; vendor/ = drittanbieter (three.js, MIT) -> nicht unser Code
        dirs[:] = [d for d in dirs if d not in (".git", "vendor")]
        for fn in files:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root)
            if rel in ALLOW_FILES:
                continue
            if os.path.splitext(fn)[1].lower() not in TEXT_EXT:
                continue
            if _ignored(root, rel):
                continue    # gitignored -> geht nie online
            try:
                with open(full, encoding="utf-8", errors="replace") as f:
                    for i, line in enumerate(f, 1):
                        if "scan:allow" in line:
                            continue    # bewusste, legitime Referenz (z.B. Pfad-Sanitizer)
                        for rx, why in compiled:
                            if rx.search(line):
                                hits.append((rel, i, why, line.strip()[:120]))
            except OSError:
                continue
    return hits


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    hits = scan(root)
    if not hits:
        print(f"OK — keine privaten Marker in publizierbaren Dateien unter {root}")
        return 0
    print(f"LEAK — {len(hits)} Treffer in publizierbaren Dateien:\n")
    for rel, i, why, snippet in hits:
        print(f"  {rel}:{i}  [{why}]\n      {snippet}")
    print("\n-> Vor Veroeffentlichung bereinigen oder gitignoren.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
