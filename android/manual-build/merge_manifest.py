#!/usr/bin/env python3
"""Merge library AAR manifests into the app manifest (manual build only).

On a normal machine Gradle's manifest merger does this automatically. This
VM cannot run Gradle (JVM networking is blocked), so the manual build
reproduces the merge: it copies, from every AAR manifest under
libs/extracted/*/AndroidManifest.xml,
  * <uses-permission>, <uses-feature> and <queries> entries (deduped),
  * <application> children: <service>, <provider>, <receiver>, <activity>
    (deduped by android:name) — this is how GeckoView's ~85 child-process
    services and its clipboard provider get into the APK.
  * NOTE (0.1.1 fix): the GeckoView AAR's
    android:zygotePreloadName is deliberately NOT merged. 0.1.0 shipped
    it and died at process start on the user's BLU phone ("keeps
    stopping" before any Activity); the preload runs before any app code
    and can kill the process. GeckoView works without it.
and replaces ${applicationId} with the real package. tools:* attributes
are dropped (lint hints only).

Usage: python3 merge_manifest.py <app-manifest> <out-manifest>
"""
import os
import sys
import xml.etree.ElementTree as ET

ANDROID_NS = "http://schemas.android.com/apk/res/android"
TOOLS_NS = "http://schemas.android.com/tools"
APP_ID = "com.filterplatform.app"

ET.register_namespace("android", ANDROID_NS)


def android_name(el):
    return el.get(f"{{{ANDROID_NS}}}name")


def clean(el):
    """Replace ${applicationId}; drop tools:* attributes (recursively)."""
    for key in list(el.attrib):
        if key.startswith(f"{{{TOOLS_NS}}}"):
            del el.attrib[key]
        elif isinstance(el.attrib[key], str):
            el.attrib[key] = el.attrib[key].replace("${applicationId}", APP_ID)
    for child in el:
        clean(child)


def merge(app_manifest, out_manifest, extracted_root):
    ET.register_namespace("android", ANDROID_NS)
    tree = ET.parse(app_manifest)
    root = tree.getroot()
    app = root.find("application")

    seen_perm = {android_name(e) for e in root.findall("uses-permission")}
    seen_feat = {android_name(e) for e in root.findall("uses-feature")}
    seen_app_children = {android_name(e) for e in app}

    lib_manifests = []
    for name in sorted(os.listdir(extracted_root)):
        p = os.path.join(extracted_root, name, "AndroidManifest.xml")
        if os.path.exists(p):
            lib_manifests.append(p)
    print(f"Merging {len(lib_manifests)} library manifests")

    for path in lib_manifests:
        try:
            lib = ET.parse(path).getroot()
        except ET.ParseError as e:
            print(f"  skip {path}: {e}")
            continue
        lib_app = lib.find("application")
        for tag in ("uses-permission",):
            for el in lib.findall(tag):
                if android_name(el) not in seen_perm:
                    seen_perm.add(android_name(el))
                    root.append(el)
        for tag in ("uses-feature",):
            for el in lib.findall(tag):
                if android_name(el) not in seen_feat:
                    seen_feat.add(android_name(el))
                    root.append(el)
        for el in lib.findall("queries"):
            root.append(el)
        if lib_app is not None:
            # 0.1.1 fix: NEVER merge android:zygotePreloadName from a
            # library. The GeckoView AAR declares it; 0.1.0 shipped it and
            # the app died at process start on the user's phone ("keeps
            # stopping" before any Activity). The preload is only a
            # startup optimisation and GeckoView works without it.
            for child in lib_app:
                if child.tag in ("service", "provider", "receiver", "activity"):
                    if android_name(child) not in seen_app_children:
                        seen_app_children.add(android_name(child))
                        app.append(child)

    clean(root)
    tree.write(out_manifest, encoding="utf-8", xml_declaration=True)
    n_services = len(app.findall("service"))
    n_providers = len(app.findall("provider"))
    print(f"Wrote {out_manifest}: {n_services} services, {n_providers} providers")


if __name__ == "__main__":
    app_manifest, out_manifest = sys.argv[1], sys.argv[2]
    extracted_root = sys.argv[3] if len(sys.argv) > 3 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "manual-build", "libs", "extracted")
    merge(app_manifest, out_manifest, extracted_root)
