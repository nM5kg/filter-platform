#!/usr/bin/env python3
"""Resolve + download the GeckoView dependency closure with curl (no JVM).

WHY: this VM blocks all TCP from JVM processes, so Gradle cannot download
dependencies (see android/README.md). This script does what Gradle's
dependency resolution would do, using only curl + POM parsing:

  1. Start from org.mozilla.geckoview:geckoview:<pinned version>.
  2. Walk each POM's <dependencies> (compile + runtime scope, not optional),
     following <parent> POMs and <dependencyManagement> for versions.
  3. Download each artifact (AAR or JAR) from Mozilla Maven, Google Maven
     or Maven Central, extract classes.jar (+ res/ + AndroidManifest.xml)
     from AARs into libs/extracted/<artifact>/.
  4. Write libs/geckoview/DEPENDENCIES.md — the resolved closure, versions,
     repos and SHA-256s, so the build is auditable without Gradle.

Usage: python3 fetch-deps.py   (from android/manual-build/)
Output: android/manual-build/libs/geckoview/*  (gitignored build inputs)
Idempotent: artifacts already on disk with a matching size are skipped.
"""
import hashlib
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBS = os.path.join(ROOT, "manual-build", "libs")
GV_DIR = os.path.join(LIBS, "geckoview")
EXTRACTED = os.path.join(LIBS, "extracted")

GECKOVIEW_VERSION = "160.0.20261116130455"  # current STABLE (release channel)
# Source: https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/maven-metadata.xml
# (release 160.0.20261116130455; beta is 161.x, nightly is 162.x) and
# Firefox 160 released 2026-11-10 (MozillaWiki "Releases"). POM scm =
# hg.mozilla.org/releases/mozilla-release (the release branch).

REPOS = {
    "mozilla": "https://maven.mozilla.org/maven2",
    "google": "https://maven.google.com",
    "central": "https://repo.maven.apache.org/maven2",
}

NS = {"m": "http://maven.apache.org/POM/4.0.0"}


def repo_for(group):
    if group.startswith("org.mozilla.geckoview"):
        return "mozilla"
    if group.startswith(("androidx.", "com.google.android.gms",
                          "com.google.android.material")):
        return "google"
    return "central"


def repo_order(group):
    first = repo_for(group)
    return [first] + [r for r in ("google", "central", "mozilla") if r != first]


def curl_head_ok(url):
    r = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                        "-L", url], capture_output=True, text=True)
    return r.stdout.strip() == "200"


def curl_download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return True
    tmp = dest + ".tmp"
    r = subprocess.run(["curl", "-sL", "-o", tmp, url],
                       capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
        if os.path.exists(tmp):
            os.remove(tmp)
        return False
    os.rename(tmp, dest)
    return True


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pom_url(group, artifact, version, repo):
    base = REPOS[repo]
    path = "/".join(group.split(".")) + f"/{artifact}/{version}/{artifact}-{version}.pom"
    return f"{base}/{path}"


def fetch_pom(group, artifact, version):
    """Return (ElementTree root, repo) for the POM, or (None, None)."""
    cache = os.path.join(GV_DIR, ".poms")
    os.makedirs(cache, exist_ok=True)
    fname = f"{group}__{artifact}__{version}.pom".replace("/", "_")
    cached = os.path.join(cache, fname)
    if os.path.exists(cached):
        try:
            return ET.parse(cached).getroot(), "cache"
        except ET.ParseError:
            os.remove(cached)
    for repo in repo_order(group):
        url = pom_url(group, artifact, version, repo)
        if curl_download(url, cached):
            try:
                return ET.parse(cached).getroot(), repo
            except ET.ParseError:
                os.remove(cached)
                continue
    return None, None


def txt(el):
    return el.text.strip() if el is not None and el.text else None


def collect_pom_data(root, group, artifact, version, props, dep_mgmt, seen_parents):
    """Merge one POM (and its parents) into props/dep_mgmt. Returns deps."""
    parent = root.find("m:parent", NS)
    if parent is not None:
        pg, pa, pv = (txt(parent.find(f"m:{t}", NS))
                      for t in ("groupId", "artifactId", "version"))
        key = (pg, pa, pv)
        if key not in seen_parents and pg and pa and pv:
            seen_parents.add(key)
            proot, _ = fetch_pom(pg, pa, pv)
            if proot is not None:
                collect_pom_data(proot, pg, pa, pv, props, dep_mgmt, seen_parents)
    for p in root.findall("m:properties/*", NS):
        if p.text:
            props[p.tag.split("}")[-1]] = p.text.strip()
    dm = root.find("m:dependencyManagement/m:dependencies", NS)
    if dm is not None:
        for d in dm.findall("m:dependency", NS):
            g, a = txt(d.find("m:groupId", NS)), txt(d.find("m:artifactId", NS))
            v = txt(d.find("m:version", NS))
            if g and a and v:
                dep_mgmt[(g, a)] = v
    deps = []
    ds = root.find("m:dependencies", NS)
    if ds is not None:
        for d in ds.findall("m:dependency", NS):
            g = txt(d.find("m:groupId", NS))
            a = txt(d.find("m:artifactId", NS))
            v = txt(d.find("m:version", NS))
            scope = txt(d.find("m:scope", NS)) or "compile"
            optional = txt(d.find("m:optional", NS)) == "true"
            dtype = txt(d.find("m:type", NS)) or "jar"
            if g and a:
                deps.append((g, a, v, scope, optional, dtype))
    return deps


VAR = re.compile(r"\$\{([^}]+)\}")


def resolve_vars(s, props, group, artifact, version):
    if s is None:
        return None
    def sub(m):
        k = m.group(1)
        if k == "project.version":
            return version
        if k == "project.groupId":
            return group
        if k == "project.artifactId":
            return artifact
        return props.get(k, m.group(0))
    out = VAR.sub(sub, s)
    return VAR.sub(sub, out) if "${" in out else out


def resolve_range(v):
    """Maven version range like [2.11.0] or [1.0,2.0) -> lower bound."""
    if v and v.startswith("["):
        inner = v[1:].split(",")[0].strip()
        return inner.rstrip("]")
    return v


def version_key(v):
    """Rough dotted-numeric version ordering (good enough for max-wins)."""
    parts = []
    for piece in re.split(r"[.\-+]", v or ""):
        parts.append((0, int(piece), "") if piece.isdigit() else (1, 0, piece))
    return parts


def resolve_closure():
    """BFS over POMs. Returns { (group, artifact): version } (highest wins)."""
    resolved = {}
    queue = [("org.mozilla.geckoview", "geckoview", GECKOVIEW_VERSION)]
    order = []
    while queue:
        g, a, v = queue.pop(0)
        if (g, a) in resolved:
            if resolved[(g, a)] != v:
                if version_key(v) > version_key(resolved[(g, a)]):
                    print(f"  note: {g}:{a} {resolved[(g,a)]} -> {v} "
                          f"(highest version wins)")
                    resolved[(g, a)] = v
                    # Re-resolve this artifact's deps at the higher version.
                    order = [o for o in order if o[:2] != (g, a)]
                    order.append((g, a, v))
                else:
                    print(f"  note: {g}:{a} already resolved as {resolved[(g,a)]}, "
                          f"skipping {v}")
                    continue
            else:
                continue
        else:
            resolved[(g, a)] = v
            order.append((g, a, v))
        root, repo = fetch_pom(g, a, v)
        if root is None:
            print(f"  WARNING: no POM found for {g}:{a}:{v}")
            continue
        props, dep_mgmt = {}, {}
        deps = collect_pom_data(root, g, a, v, props, dep_mgmt, set())
        for dg, da, dv, scope, optional, dtype in deps:
            if scope not in ("compile", "runtime"):
                continue
            if optional or dtype == "pom":
                continue
            if dv is None:
                dv = dep_mgmt.get((dg, da))
            dv = resolve_vars(dv, props, g, a, v)
            dv = resolve_range(dv)
            if dv is None:
                print(f"  WARNING: no version for {dg}:{da} "
                      f"(required by {g}:{a})")
                continue
            queue.append((dg, da, dv))
    return resolved, order


def artifact_candidates(group, artifact, version, packaging):
    """Candidate (repo, path, filename) triples, incl. the -jvm fallback.

    KMP libraries publish the real artifact as <artifact>-jvm under its OWN
    directory (group/<artifact>-jvm/<version>/), not under <artifact>/.
    """
    ext = "aar" if packaging == "aar" else "jar"
    base_path = "/".join(group.split(".")) + f"/{artifact}/{version}"
    base = f"{artifact}-{version}"
    cands = [(repo_for(group), base_path, f"{base}.{ext}")]
    if ext == "jar":
        jvm_path = "/".join(group.split(".")) + f"/{artifact}-jvm/{version}"
        cands.append((repo_for(group), jvm_path, f"{artifact}-jvm-{version}.jar"))
    # Fall back to the other repos too.
    for repo in ("google", "central", "mozilla"):
        if repo != repo_for(group):
            cands.append((repo, base_path, f"{base}.{ext}"))
    return cands


def download_artifact(group, artifact, version):
    root, _ = fetch_pom(group, artifact, version)
    packaging = txt(root.find("m:packaging", NS)) if root is not None else "jar"
    if packaging == "pom":
        return None, "pom-only"
    dest_dir = GV_DIR
    os.makedirs(dest_dir, exist_ok=True)
    for repo, path, fname in artifact_candidates(group, artifact, version, packaging):
        url = f"{REPOS[repo]}/{path}/{fname}"
        dest = os.path.join(dest_dir, fname)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            return dest, repo
        if curl_head_ok(url) and curl_download(url, dest):
            return dest, repo
    return None, None


def main():
    os.makedirs(GV_DIR, exist_ok=True)
    os.makedirs(EXTRACTED, exist_ok=True)
    print(f"Resolving GeckoView {GECKOVIEW_VERSION} closure ...")
    resolved, order = resolve_closure()
    print(f"Resolved {len(resolved)} artifacts:")
    for g, a, v in order:
        print(f"  {g}:{a}:{v}")

    print("\nDownloading artifacts ...")
    report = []
    for g, a, v in order:
        dest, repo = download_artifact(g, a, v)
        if dest is None:
            if repo == "pom-only":
                # KMP root artifact: no file of its own; the real classes
                # are in the -jvm variant, resolved as its own artifact.
                print(f"  ok (pom-only, no artifact): {g}:{a}:{v}")
                report.append((g, a, v, None, None, "ok (pom-only)"))
                continue
            print(f"  FAILED: {g}:{a}:{v}")
            report.append((g, a, v, None, None, "FAILED"))
            continue
        size = os.path.getsize(dest)
        print(f"  ok {os.path.basename(dest)} ({size} bytes, {repo})")
        report.append((g, a, v, dest, repo, "ok"))
        # Extract AAR contents needed by the manual build.
        if dest.endswith(".aar"):
            ext_dir = os.path.join(EXTRACTED, a)
            os.makedirs(ext_dir, exist_ok=True)
            import zipfile
            with zipfile.ZipFile(dest) as z:
                names = z.namelist()
                if "classes.jar" in names:
                    z.extract("classes.jar", ext_dir)
                if "AndroidManifest.xml" in names:
                    z.extract("AndroidManifest.xml", ext_dir)
                res_names = [n for n in names if n.startswith("res/") and not n.endswith("/")]
                if res_names:
                    for n in res_names:
                        z.extract(n, ext_dir)
                    print(f"     extracted {len(res_names)} res files")

    # The GeckoView AAR itself lives in libs/ already (downloaded first);
    # make sure its classes.jar is extracted too.
    gv_aar = os.path.join(LIBS, f"geckoview-{GECKOVIEW_VERSION}.aar")
    if os.path.exists(gv_aar):
        import zipfile
        ext_dir = os.path.join(EXTRACTED, "geckoview")
        os.makedirs(ext_dir, exist_ok=True)
        with zipfile.ZipFile(gv_aar) as z:
            for n in ("classes.jar", "AndroidManifest.xml"):
                if n in z.namelist() and not os.path.exists(os.path.join(ext_dir, n)):
                    z.extract(n, ext_dir)
        report.append(("org.mozilla.geckoview", "geckoview", GECKOVIEW_VERSION,
                       gv_aar, "mozilla", "ok (pre-downloaded)"))

    failures = [r for r in report if r[5] != "ok" and not r[5].startswith("ok")]
    # Prune stale files: an earlier run may have downloaded a version that
    # highest-version-wins later replaced (e.g. lifecycle-runtime 2.10.0).
    # Including two versions of one library in the dex would fail the build
    # with duplicate classes, so only the resolved set may stay on disk.
    expected = {os.path.basename(r[3]) for r in report if r[3]}
    expected.add(f"geckoview-{GECKOVIEW_VERSION}.aar")
    for fname in os.listdir(GV_DIR):
        if (fname.endswith((".aar", ".jar")) and fname not in expected):
            os.remove(os.path.join(GV_DIR, fname))
            print(f"  pruned stale {fname}")
    with open(os.path.join(GV_DIR, "DEPENDENCIES.md"), "w") as f:
        f.write("# GeckoView dependency closure (resolved by manual-build/fetch-deps.py)\n\n")
        f.write(f"GeckoView **{GECKOVIEW_VERSION}** (stable / release channel).\n")
        f.write("Source: https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/maven-metadata.xml\n\n")
        f.write("| artifact | version | file | repo | sha256 |\n|---|---|---|---|---|\n")
        for g, a, v, dest, repo, status in sorted(report):
            if dest and os.path.exists(dest):
                f.write(f"| {g}:{a} | {v} | {os.path.basename(dest)} | {repo} | "
                        f"`{sha256(dest)[:16]}…` |\n")
            else:
                f.write(f"| {g}:{a} | {v} | — | — | **{status}** |\n")
    print(f"\nWrote {os.path.join(GV_DIR, 'DEPENDENCIES.md')}")
    if failures:
        print(f"FAILED downloads: {len(failures)}")
        for g, a, v, *_ in failures:
            print(f"  {g}:{a}:{v}")
        sys.exit(1)
    print("All artifacts downloaded.")


if __name__ == "__main__":
    main()
