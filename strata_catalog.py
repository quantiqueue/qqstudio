"""qqstudio: print Strata's model catalog for this computer as JSON (run with Strata's own Python).

    python strata_catalog.py <Strata Terminal folder>

Uses the Terminal's own catalog code (strata_cli/launch/catalog.py, the list `strata launch` and the Strata app show),
so the sizes, the fit words and what is installed match what Strata itself would say. Prints one JSON object:
{"ok": true, "rows": [...], "computer": "...", "unavailable": [...]} or {"ok": false, "error": "..."}.
"""
import json
import sys


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    sys.path.insert(0, root)
    real = sys.stdout
    sys.stdout = sys.stderr                     # the catalog code may print; only our JSON goes to stdout
    try:
        from strata_cli.launch.catalog import Catalog
        cat = Catalog()
        hw = cat.hardware()
        rows = [{
            "family": r.family, "familyTitle": r.family_title, "model": r.model, "id": r.id, "title": r.title,
            "about": r.about, "downloadGb": r.download_gb, "needVramGb": r.need_vram_gb, "needRamGb": r.need_ram_gb,
            "spillGb": r.spill_gb, "verdict": r.verdict, "words": r.words, "experimental": r.experimental,
            "images": r.images, "installed": r.installed, "recommended": r.recommended,
        } for r in cat.rows(hw)]
        files = []                              # each size's exact files on Hugging Face: what qqstudio tags as "Strata"
        try:
            import re
            setup = cat.strata.setup_module()
            for r in cat.rows(hw):
                fam = setup.FAMILIES.get(r.family) or {}
                if "hf" not in fam:             # not GGUF files on the Hub (NVFP4 packs): not something a GGUF search finds
                    continue
                base = setup.model_hf(fam, r.model)
                m = re.match(r"https?://[^/]+/([^/]+/[^/]+)/resolve/[0-9a-f]+/(.*)$", base)
                if not m:
                    continue
                for i in range(1, setup.model_shards(fam, r.model) + 1):
                    name = setup.model_file(fam, r.model, i)
                    pin = setup.file_pin(base + name)
                    # every size Strata accepts for this file: its pin, and the other layouts it also knows (sha256_alt:
                    # e.g. UD-Q4_K_XL re-uploaded at another commit)
                    sizes = ([pin[0]] if pin else []) + [alt[0] for alt in (fam.get("sha256_alt") or {}).get(name, [])]
                    files.append({"repo": m.group(1), "path": m.group(2) + name, "sizes": sizes,
                                  "family": r.family, "model": r.model})
        except Exception as e:                  # noqa: BLE001 - tags are a convenience; the list still shows
            files = []
            print(f"files: {type(e).__name__}: {e}", file=sys.stderr)
        try:
            computer = cat.computer().line()
        except Exception:                       # a label only
            computer = ""
        out = {"ok": True, "rows": rows, "files": files, "computer": computer,
               "unavailable": [{"title": t, "reason": w} for t, w in cat.unavailable(hw)]}
    except Exception as e:                      # noqa: BLE001 - said to the user as one line
        out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        sys.stdout = real
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
