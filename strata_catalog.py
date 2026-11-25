"""qqstudio: print Strata's model catalog for this computer as JSON (run with Strata's own Python).

    python strata_catalog.py <Strata Terminal folder>

Uses the Terminal's own catalog code (strata_cli/launch/catalog.py, the list `strata launch` and the Strata app show),
so the sizes, the fit words and what is installed match what Strata itself would say. Prints one JSON object:
{"ok": true, "rows": [...], "computer": "...", "unavailable": [...]} or {"ok": false, "error": "..."}.
"""
import json
import sys


HF_BASE = r"https?://huggingface\.co/([^/]+/[^/]+)/resolve/[^/]+/?(.*)$"


def inkling_files(r) -> list:
    """Inkling-2-Mini (Strata 0.1.65+): one file per size, either Strata's own .strata build or an Unsloth GGUF, from the
    repos Strata downloads them from (data/inkling-sources.json). The .strata sizes' picture reader (Inkling-2-Mini-Vision.strata)
    and the GGUFs' DSpark drafter are optional extras ("extra": not part of the set; Strata finds them beside the model)."""
    import re
    from strata_control import inkling_family
    name = inkling_family.build_file(r.model)
    src = (inkling_family.sources_for(name) or [{}])[0]
    m = re.match(HF_BASE, src.get("base") or "")
    if not m:
        return []
    repo, sub = m.group(1), (m.group(2).strip("/") + "/" if m.group(2).strip("/") else "")
    sha = lambda n: [inkling_family.sha256_of(n)] if inkling_family.sha256_of(n) else []
    out = [{"repo": repo, "path": sub + name, "sizes": [inkling_family.size_of(name)], "shas": sha(name), "family": r.family, "model": r.model}]
    # a GGUF size reads pictures with the repo's own mmproj (Strata takes it from beside the model); a .strata size with the Vision shard
    extras = [inkling_family.DSPARK_GGUF_FILE] if inkling_family.is_gguf_build(r.model) else [inkling_family.VISION_FILE]
    for x in extras:
        xs = (inkling_family.sources_for(x) or [{}])[0]
        xm = re.match(HF_BASE, xs.get("base") or "")
        if xm:
            xsub = xm.group(2).strip("/") + "/" if xm.group(2).strip("/") else ""
            out.append({"repo": xm.group(1), "path": xsub + x, "sizes": [inkling_family.size_of(x)], "shas": sha(x), "family": r.family,
                        "model": r.model, "extra": "vision" if x == inkling_family.VISION_FILE else "drafter"})
    return out


def own_path_files(setup, fam, r) -> list:
    """Qwen3.6-35B-A3B and the other own-path families (setup.OWN_PATH_FAMILIES, which Strata's model feed also fills): one GGUF
    per size, read in place by the engine, with the family's picture reader (mmproj) beside it as an optional extra. The names,
    folders and pins are the ones Strata's own installer uses (install_own_path: fam["file"], fam["hf"], fam["sha256"])."""
    import re

    def entry(base, name, extra=None):
        m = re.match(r"https?://[^/]+/([^/]+/[^/]+)/resolve/[^/]+/?(.*)$", base)
        if not m or not name:
            return None
        sub = m.group(2).strip("/")
        pin = (fam.get("sha256") or {}).get(name) or setup.file_pin(base + name)
        e = {"repo": m.group(1), "path": (sub + "/" if sub else "") + name, "sizes": [pin[0]] if pin else [],
             "shas": [pin[1]] if pin and len(pin) > 1 and pin[1] else [], "family": r.family, "model": r.model}
        if extra:
            e["extra"] = extra
        return e

    base = fam["hf"].format(q=r.model)
    out = [entry(base, fam["file"].format(q=r.model))]
    if fam.get("mmproj"):
        out.append(entry(fam.get("mmproj_hf") or base, fam["mmproj"], "vision"))
    return [e for e in out if e]


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
            own = getattr(setup, "OWN_PATH_FAMILIES", None) or {}
            for r in cat.rows(hw):
              try:                              # one family that can't be read leaves the others' tags alone
                if r.family == "inkling-2-mini":
                    files += inkling_files(r)
                    continue
                if r.family in own:
                    files += own_path_files(setup, own[r.family], r)
                    continue
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
                    alts = list((fam.get("sha256_alt") or {}).get(name, []))
                    sizes = ([pin[0]] if pin else []) + [alt[0] for alt in alts]
                    # the SHA-256 of each accepted file: qqstudio also finds a pinned file the uploader has moved or renamed
                    shas = [x[1] for x in ([pin] if pin else []) + alts if len(x) > 1 and x[1]]
                    files.append({"repo": m.group(1), "path": m.group(2) + name, "sizes": sizes, "shas": shas,
                                  "family": r.family, "model": r.model})
              except Exception as e:            # noqa: BLE001
                print(f"files: {r.family} {r.model}: {type(e).__name__}: {e}", file=sys.stderr)
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
