# Attribution / modification notice

Retarget to See is a browser implementation derived from ideas, retargeting mathematics, preset schema and preset data from:

- **BlendCap**
- Author/repository: Arcomade — https://github.com/Arcomade/BlendCap
- License: GNU General Public License v3.0
- Source revision inspected for this port: BlendCap `main` as available in September 2026.

## Modifications

The Blender/Python implementation was not embedded or executed in the browser. The retargeting path was reimplemented in JavaScript/Three.js for FBX skeletons, including world-space delta-from-rest rotation transfer, basis/world location transfer, head-local face placement, preset-driven bone maps, prefix resolution, face amplitude controls and a browser-side FK→IK bake.

The bundled JSON files under `presets/` are copies of BlendCap's shipped retarget maps and remain GPL-3.0-covered material.

This port cannot reproduce Blender-only constraints, drivers or rig logic that are absent from an exported FBX.
