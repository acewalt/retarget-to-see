/*
 * Retarget to See
 * Browser retarget engine adapted from the world-space delta-from-rest
 * approach used by Arcomade/BlendCap (GPL-3.0).
 *
 * This is a clean web implementation on top of Three.js. It does not
 * execute Blender/bpy.
 */
import * as THREE from "three";

const EPS = 1e-8;
const FACE_REGIONS = ["jaw","gaze","lids","brows","lips","cheeks","nose","tongue"];

export { FACE_REGIONS };

export function faceRegionFromSource(name=""){
  const n = String(name).toLowerCase();
  if (!n) return null;
  if (n.includes("tongue")) return "tongue";
  if (n.includes("jaw") || n.includes("chin")) return "jaw";
  if (n === "lefteye" || n === "righteye" || n.endsWith(":lefteye") || n.endsWith(":righteye")) return "gaze";
  if (n.includes("lid")) return "lids";
  if (n.includes("brow") || n.includes("forehead") || n.includes("temple")) return "brows";
  if (n.includes("lip") || n.includes("mouthcorner") || n.includes("mouth_corner")) return "lips";
  if (n.includes("cheek")) return "cheeks";
  if (n.includes("nose") || n.includes("nostril")) return "nose";
  return null;
}

function sideCanonical(n){
  return n
    .replace(/(^|[._\- ])left(?=$|[._\- ])/g,"$1l")
    .replace(/(^|[._\- ])right(?=$|[._\- ])/g,"$1r")
    .replace(/([._\-])l$/g,"$1left")
    .replace(/([._\-])r$/g,"$1right");
}

export function normalizeBoneName(name=""){
  let n = String(name).trim().toLowerCase();
  if (!n) return "";
  n = n.replace(/\|/g,":");
  const colon = n.lastIndexOf(":");
  if (colon >= 0) n = n.slice(colon + 1);
  n = sideCanonical(n);
  n = n
    .replace(/^(mixamorig|bip\d*|armature|skeleton)[_\-. ]*/,"")
    .replace(/^(def|org|mch|ctrl|control|bone)[_\-. ]+/,"")
    .replace(/^c[_\-.]+/,"")
    .replace(/upperarm/g,"arm")
    .replace(/lowerarm/g,"forearm")
    .replace(/upleg/g,"thigh")
    .replace(/upperleg/g,"thigh")
    .replace(/lowerleg/g,"shin")
    .replace(/toebase/g,"toe")
    .replace(/pinky/g,"little")
    .replace(/[^a-z0-9]/g,"");
  return n;
}

function looseBoneKey(name=""){
  let n = String(name).trim().toLowerCase();
  if (!n) return "";

  n = n.replace(/\\/g,"/").replace(/\|/g,":");

  // Normal namespace form: "rig:FK-Thigh.L", "mixamorig1:Hips".
  const colon = n.lastIndexOf(":");
  if (colon >= 0) n = n.slice(colon + 1);

  // Three.js/FBXLoader can flatten namespace punctuation in node names,
  // producing e.g. "mixamorig1Hips" or "rigFK-ThighL". Strip those
  // well-known namespace prefixes even when no separator survived.
  n = n
    .replace(/^(mixamorig\d*|armature\d*|skeleton\d*|rig\d*|bip\d*)[_ .:\/-]*/,"")
    .replace(/^(mixamorig\d*|rig\d*)(?=[a-z])/,"");

  return n.replace(/[^a-z0-9]/g,"");
}

function semanticBoneKey(name=""){
  let n = looseBoneKey(name);
  if (!n) return "";

  // Secondary key only for fallback. It bridges common naming dialects
  // without erasing FK/IK/control semantics.
  n = n
    .replace(/left/g,"l")
    .replace(/right/g,"r")
    .replace(/upperarm/g,"arm")
    .replace(/lowerarm/g,"forearm")
    .replace(/upleg/g,"thigh")
    .replace(/upperleg/g,"thigh")
    .replace(/lowerleg/g,"shin")
    .replace(/toebase/g,"toe");
  return n;
}

export function stripKnownPrefix(name="", prefix=""){
  const n = String(name);
  if (prefix && n.startsWith(prefix)) return n.slice(prefix.length);
  return n;
}

export function guessPrefix(shortNames, actualNames){
  const counts = new Map();
  const shorts = [...new Set((shortNames || []).filter(Boolean))];
  const actual = actualNames || [];
  for (const s of shorts){
    for (const a of actual){
      if (a === s){
        counts.set("", (counts.get("") || 0) + 1);
      } else if (a.endsWith(s)){
        const p = a.slice(0, a.length - s.length);
        if (p.length <= 64) counts.set(p, (counts.get(p) || 0) + 1);
      }
    }
  }
  let best = "", score = -1;
  for (const [prefix,count] of counts){
    const adjusted = count - Math.min(prefix.length,20) * 0.002;
    if (adjusted > score){
      best = prefix;
      score = adjusted;
    }
  }
  return best;
}

function cloneTransform(bone){
  return {
    position: bone.position.clone(),
    quaternion: bone.quaternion.clone(),
    scale: bone.scale.clone()
  };
}

function getBoneDepth(bone){
  let d = 0;
  let p = bone.parent;
  while (p){
    if (p.isBone) d++;
    p = p.parent;
  }
  return d;
}

function decomposeWorld(matrix){
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return {position, quaternion, scale};
}

export function createRigState(root, fileName=""){
  root.updateMatrixWorld(true);
  const bones = [];
  const skinBoneNames = new Set();
  const weightedBoneNames = new Set();

  root.traverse(o => {
    if (o.isBone) bones.push(o);

    if (o.isSkinnedMesh && o.skeleton?.bones){
      for (const b of o.skeleton.bones){
        if (b?.name) skinBoneNames.add(b.name);
      }

      // Skeleton.bones can contain exported control bones with zero actual
      // vertex influence. For retargeting an FBX control rig we care about
      // bones that REALLY deform the mesh, so inspect non-zero skin weights.
      const skinIndex = o.geometry?.getAttribute?.("skinIndex");
      const skinWeight = o.geometry?.getAttribute?.("skinWeight");
      if (skinIndex && skinWeight){
        const count = Math.min(skinIndex.count,skinWeight.count);
        for (let i=0;i<count;i++){
          const indices = [
            skinIndex.getX(i),
            skinIndex.getY(i),
            skinIndex.getZ(i),
            skinIndex.getW(i)
          ];
          const weights = [
            skinWeight.getX(i),
            skinWeight.getY(i),
            skinWeight.getZ(i),
            skinWeight.getW(i)
          ];
          for (let j=0;j<4;j++){
            if (weights[j] <= 1e-6) continue;
            const bone = o.skeleton.bones[Math.round(indices[j])];
            if (bone?.name) weightedBoneNames.add(bone.name);
          }
        }
      }
    }
  });
  const boneMap = new Map();
  const rest = new Map();

  for (const bone of bones){
    if (!boneMap.has(bone.name)) boneMap.set(bone.name, bone);
  }

  // A zero-weight control bone can still deform the mesh structurally when
  // weighted bones are parented underneath it. Earlier versions treated all
  // zero-weight controls as useless and redirected them to DEF bones. That is
  // wrong for master controls such as CloudRig's TORSO-Spine/root hierarchy.
  const hierarchyDriverBoneNames = new Set(weightedBoneNames);
  for (const weightedName of weightedBoneNames){
    let bone = boneMap.get(weightedName);
    let parent = bone?.parent;
    while (parent?.isBone){
      if (parent.name) hierarchyDriverBoneNames.add(parent.name);
      parent = parent.parent;
    }
  }

  for (const bone of bones){
    bone.updateMatrix();
  }
  root.updateMatrixWorld(true);

  for (const bone of bones){
    const world = bone.matrixWorld.clone();
    const wd = decomposeWorld(world);
    rest.set(bone.name, {
      ...cloneTransform(bone),
      world,
      worldPosition: wd.position,
      worldQuaternion: wd.quaternion,
      worldScale: wd.scale,
      depth: getBoneDepth(bone),
      externalParentWorld: bone.parent && !bone.parent.isBone
        ? bone.parent.matrixWorld.clone()
        : null
    });
  }

  const rig = {
    root,
    rootRest:cloneTransform(root),
    fileName,
    bones,
    boneMap,
    boneNames: bones.map(b => b.name),
    skinBoneNames,
    weightedBoneNames,
    hierarchyDriverBoneNames,
    cloudRigProfile:false,
    rest,
    animations: Array.isArray(root.animations) ? root.animations : [],
    mixer: new THREE.AnimationMixer(root),
    activeClip: null,
    activeAction: null,
    currentTime: 0
  };
  rig.cloudRigProfile = isCloudRigExport(rig);
  return rig;
}

export function resetRigToRest(rig){
  if (!rig) return;
  if (rig.mixer){
    rig.mixer.stopAllAction();
    rig.mixer.setTime(0);
  }
  if (rig.rootRest){
    rig.root.position.copy(rig.rootRest.position);
    rig.root.quaternion.copy(rig.rootRest.quaternion);
    rig.root.scale.copy(rig.rootRest.scale);
    rig.root.updateMatrix();
  }
  for (const bone of rig.bones){
    const r = rig.rest.get(bone.name);
    if (!r) continue;
    bone.position.copy(r.position);
    bone.quaternion.copy(r.quaternion);
    bone.scale.copy(r.scale);
    bone.updateMatrix();
  }
  rig.root.updateMatrixWorld(true);
  rig.activeClip = null;
  rig.activeAction = null;
  rig.currentTime = 0;
}

export function activateClip(rig, clip){
  if (!rig) return null;
  rig.mixer.stopAllAction();
  rig.mixer.setTime(0);
  rig.activeClip = clip || null;
  rig.activeAction = null;
  if (clip){
    const action = rig.mixer.clipAction(clip);
    action.reset();
    action.enabled = true;
    action.clampWhenFinished = true;
    action.setLoop(THREE.LoopOnce, 0);
    action.play();
    rig.activeAction = action;
    rig.mixer.update(0);
  }
  rig.root.updateMatrixWorld(true);
  return rig.activeAction;
}

export function setRigTime(rig, time){
  if (!rig) return;
  const duration = rig.activeClip?.duration || 0;
  const t = duration > 0 ? Math.max(0, Math.min(time, duration)) : 0;
  // LoopOnce actions become paused when sampled exactly at the final frame.
  // Unpause before every random-access seek so scrubbing/baking can move
  // backwards again after touching clip.duration.
  if (rig.activeAction){
    rig.activeAction.enabled = true;
    rig.activeAction.paused = false;
  }
  rig.mixer.setTime(t);
  rig.root.updateMatrixWorld(true);
  rig.currentTime = t;
}

export function resolveBone(rig, shortName="", prefix=""){
  if (!rig || !shortName) return null;
  const n = String(shortName).trim();
  if (!n) return null;

  // 1) Exact paths first.
  if (rig.boneMap.has(n)) return rig.boneMap.get(n);
  if (prefix){
    if (rig.boneMap.has(prefix + n)) return rig.boneMap.get(prefix + n);

    // Prefixes entered by the user often lose ":"/"_" after FBXLoader
    // sanitization. Try the compact form as well.
    const compactPrefixed = looseBoneKey(prefix + n);
    const compactHits = rig.bones.filter(b => looseBoneKey(b.name) === compactPrefixed);
    if (compactHits.length === 1) return compactHits[0];
  }

  // 2) Literal suffix. Useful for intact Mixamo namespaces.
  const lower = n.toLowerCase();
  const suffixMatches = rig.bones.filter(b => b.name.toLowerCase().endsWith(lower));
  if (suffixMatches.length === 1) return suffixMatches[0];

  // 3) Punctuation/namespace-insensitive key. This is the important path
  // for FBXLoader names such as "rigFK-ThighL" vs preset "FK-Thigh.L".
  const loose = looseBoneKey(n);
  if (loose){
    const looseMatches = rig.bones.filter(b => looseBoneKey(b.name) === loose);
    if (looseMatches.length === 1) return looseMatches[0];
    if (looseMatches.length > 1 && prefix){
      const pp = looseBoneKey(prefix);
      const preferred = looseMatches.filter(b => looseBoneKey(b.name).startsWith(pp));
      if (preferred.length === 1) return preferred[0];
    }
  }

  // 4) Existing canonical matcher.
  const canon = normalizeBoneName(n);
  if (canon){
    const canonMatches = rig.bones.filter(b => normalizeBoneName(b.name) === canon);
    if (canonMatches.length === 1) return canonMatches[0];
  }

  // 5) Semantic alias matcher for common rig dialects.
  const semantic = semanticBoneKey(n);
  if (semantic){
    const semanticMatches = rig.bones.filter(b => semanticBoneKey(b.name) === semantic);
    if (semanticMatches.length === 1) return semanticMatches[0];
  }

  return null;
}


function anatomicalBoneKey(name=""){
  let n = looseBoneKey(name);
  if (!n) return "";

  // Strip rig-role prefixes. Unlike normalizeBoneName(), this deliberately
  // treats FK/DEF/ORG versions of the same anatomical bone as equivalent.
  n = n
    .replace(/^(def|org|mch|fk|ik|ctrl|control|bone)+/,"")
    .replace(/^c(?=[a-z])/,"")
    // CloudRig commonly exports DEF-f_index.01.L style names while the
    // preset uses FK-Finger_Index1.L. Normalize both dialects.
    .replace(/^f(?=(thumb|index|middle|ring|pinky|little))/,"")
    .replace(/finger/g,"")
    .replace(/left/g,"l")
    .replace(/right/g,"r")
    .replace(/upperarm/g,"arm")
    .replace(/lowerarm/g,"forearm")
    .replace(/upleg/g,"thigh")
    .replace(/upperleg/g,"thigh")
    .replace(/lowerleg/g,"shin")
    .replace(/knee/g,"shin")
    .replace(/toebase/g,"toe")
    .replace(/toes/g,"toe")
    .replace(/pinky/g,"little")
    .replace(/clavicle/g,"shoulder")
    .replace(/spine0+([1-9])/g,"spine$1")
    .replace(/(thumb|index|middle|ring|little)0+([1-9])/g,"$1$2");

  // CloudRig locomotion/control names. In an FBX without Blender
  // constraints these controls cannot drive the skinned skeleton, so map
  // their motion directly to the pelvis/hips deform bone.
  if (n === "root" || n === "hipspine" || n === "torsospine") return "hips";

  return n;
}

function fingerDescriptor(name=""){
  let key = anatomicalBoneKey(name);
  if (!key) return null;

  const sideMatch = key.match(/([lr])$/);
  const side = sideMatch ? sideMatch[1] : "";
  if (side) key = key.slice(0,-1);

  const familyMatch = key.match(/(thumb|index|middle|ring|little)/);
  if (!familyMatch) return null;
  const family = familyMatch[1];

  const digitMatch = key.match(/(?:thumb|index|middle|ring|little)(\d+)/);
  if (!digitMatch) return null;
  const segment = Number(digitMatch[1]);
  if (!Number.isFinite(segment)) return null;

  return {family,segment,side};
}

function findFingerDeformBone(rig,name){
  const deformNames = deformBoneNameSet(rig);
  if (!deformNames.size) return null;
  const wanted = fingerDescriptor(name);
  if (!wanted) return null;

  const candidates = [];
  for (const bone of rig.bones){
    if (!deformNames.has(bone.name)) continue;
    const got = fingerDescriptor(bone.name);
    if (!got) continue;
    if (got.family !== wanted.family) continue;
    if (got.segment !== wanted.segment) continue;
    if (wanted.side && got.side && got.side !== wanted.side) continue;
    candidates.push(bone);
  }

  return candidates.length === 1 ? candidates[0] : null;
}

function deformBoneNameSet(rig){
  if (rig?.weightedBoneNames?.size) return rig.weightedBoneNames;
  return rig?.skinBoneNames || new Set();
}

function skinBoneCandidates(rig,key){
  const deformNames = deformBoneNameSet(rig);
  if (!deformNames.size || !key) return [];
  const out = [];
  for (const bone of rig.bones){
    if (!deformNames.has(bone.name)) continue;
    const k = anatomicalBoneKey(bone.name);
    if (k === key) out.push(bone);
  }
  return out;
}

function segmentInsensitiveKey(name=""){
  let key = anatomicalBoneKey(name);
  if (!key) return "";

  // Do NOT collapse numbers for fingers or spine: those numbers are semantic.
  if (/(thumb|index|middle|ring|little|spine)/.test(key)) return key;

  // Rigify/CloudRig may split long deform chains into .001/.002 segments.
  // FBXLoader removes punctuation, so DEF-upper_arm.L.001 becomes arml001.
  // For matching an FK control, treat those trailing segment numbers as the
  // same anatomical limb and choose the closest weighted segment spatially.
  key = key
    .replace(/([lr])0*\d+$/,"$1")
    .replace(/0*\d+([lr])$/,"$1");

  return key;
}

function sideHintFromName(name=""){
  const key = anatomicalBoneKey(name);
  if (!key) return "";
  const m = key.match(/([lr])(?:0*\d+)?$/);
  return m ? m[1] : "";
}

function broadRegionKey(name=""){
  const key = segmentInsensitiveKey(name);
  if (!key) return "";

  if (key.includes("forearm")) return "forearm";
  if (key.includes("arm")) return "arm";
  if (key.includes("shoulder")) return "shoulder";
  if (key.includes("thigh")) return "thigh";
  if (key.includes("shin") || key.includes("calf")) return "shin";
  if (key.includes("foot")) return "foot";
  if (key.includes("toe")) return "toe";
  if (key.includes("hand")) return "hand";
  if (key.includes("neck")) return "neck";
  if (key.includes("head")) return "head";
  if (key.includes("chest")) return "chest";
  if (key.includes("spine")) return "spine";
  if (key.includes("hips") || key.includes("pelvis") || key === "hip") return "hips";
  return key;
}

function nearestCandidateToControl(rig,direct,candidates){
  if (!candidates?.length) return null;
  if (candidates.length === 1) return candidates[0];
  if (!direct) return null;

  const controlRest = rig.rest.get(direct.name);
  if (!controlRest) return null;

  const ranked = candidates
    .map(b => ({
      bone:b,
      d:controlRest.worldPosition.distanceTo(
        rig.rest.get(b.name)?.worldPosition || controlRest.worldPosition
      )
    }))
    .sort((a,b) => a.d - b.d);

  if (!ranked.length) return null;

  // Overlapping FK/deform bones normally have ~zero distance. For segmented
  // deform chains pick the closest segment. Side/region filtering happens
  // before this function, so nearest is a much safer fallback than a name guess.
  return ranked[0].bone;
}

function segmentedDeformCandidates(rig,name){
  const deformNames = deformBoneNameSet(rig);
  if (!deformNames.size) return [];

  const wantedKey = segmentInsensitiveKey(name);
  const wantedSide = sideHintFromName(name);
  const wantedRegion = broadRegionKey(name);

  return rig.bones.filter(b => {
    if (!deformNames.has(b.name)) return false;
    const candidateSide = sideHintFromName(b.name);
    if (wantedSide && candidateSide && candidateSide !== wantedSide) return false;

    const candidateKey = segmentInsensitiveKey(b.name);
    if (candidateKey === wantedKey) return true;

    // Last-resort anatomical region fallback for names such as
    // DEF-upper_arm.L.001 vs FK-UpperArm.L.
    return wantedRegion
      && broadRegionKey(b.name) === wantedRegion;
  });
}

function isCloudRigExport(rig){
  if (!rig?.boneMap) return false;
  const required = [
    "TORSO-Spine",
    "HIP-Spine",
    "DEF-Hips",
    "DEF-Spine",
    "DEF-Chest",
    "DEF-UpperArm_1L",
    "DEF-UpperArm_1R",
    "DEF-Thigh_1L",
    "DEF-Thigh_1R"
  ];
  return required.every(name => rig.boneMap.has(name));
}

function cloudRigSide(name=""){
  const raw = String(name);
  if (/(?:\.L|_L|Left|left|L)$/.test(raw)) return "L";
  if (/(?:\.R|_R|Right|right|R)$/.test(raw)) return "R";

  const compact = raw.toLowerCase().replace(/[^a-z0-9]/g,"");
  if (/left/.test(compact)) return "L";
  if (/right/.test(compact)) return "R";
  if (/l$/.test(compact)) return "L";
  if (/r$/.test(compact)) return "R";
  return "";
}

function resolveCloudRigDeformAlias(rig,shortName=""){
  if (!isCloudRigExport(rig)) return null;

  const raw = String(shortName || "");
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g,"");
  const side = cloudRigSide(raw);

  const exact = name => rig.boneMap.get(name) || null;
  const sided = base => side ? exact(`${base}${side}`) : null;

  // CloudRig FK controls are a constraint layer. In a plain FBX those
  // constraints are absent, so retarget directly onto the SECTION ROOTS of
  // the deform chains. Secondary _2 bones remain untouched and inherit
  // naturally from _1, matching the hierarchy supplied by the rig.
  if (key === "fkhead" || key === "head") return exact("DEF-Head");
  if (key === "fkneck" || key === "neck") return exact("DEF-Neck");
  if (key === "fkspine" || key === "spine") return exact("DEF-Spine");
  if (key === "fkchest" || key === "chest") return exact("DEF-Chest");
  if (key === "hipspine" || key === "fkhips" || key === "hips") return exact("DEF-Hips");

  if (key.includes("shoulder")) return sided("DEF-Shoulder");
  if (key.includes("upperarm")) return sided("DEF-UpperArm_1");
  if (key.includes("forearm")) return sided("DEF-Forearm_1");
  if (key.includes("hand")) return sided("DEF-Hand");

  if (key.includes("thigh") || key.includes("upleg") || key.includes("upperleg")){
    return sided("DEF-Thigh_1");
  }
  if (key.includes("knee") || key.includes("lowerleg") || key.includes("shin")){
    return sided("DEF-Knee_1");
  }
  if (key.includes("toes") || key.includes("toebase") || key.includes("toe")){
    // DEF-Toes can exist in the FBX skin skeleton with zero direct weight.
    // It is still the correct anatomical endpoint of the DEF leg chain.
    return sided("DEF-Toes");
  }
  if (key.includes("foot")) return sided("DEF-Foot");

  return null;
}

export function resolveRetargetTargetBone(rig,shortName="",prefix=""){
  if (!rig || !shortName) return null;

  const cloudRigAlias = resolveCloudRigDeformAlias(rig,shortName);
  if (cloudRigAlias) return cloudRigAlias;

  const direct = resolveBone(rig,shortName,prefix);
  const deformNames = deformBoneNameSet(rig);

  // Plain skeleton FBXs often skin directly to the mapped bone.
  if (!deformNames.size) return direct;

  // For browser/FBX FK retargeting, only accept a direct mapped bone when
  // it has REAL vertex influence. Blender control bones may be ancestors of
  // deform bones, but their intended behavior depends on constraints/drivers
  // that are not exported to FBX. Baking those controls directly caused
  // unstable limb/pelvis behavior and mesh tearing.
  if (direct && deformNames.has(direct.name)) return direct;

  // Control-rig FBXs (Rigify/CloudRig/ARP) usually export both control
  // bones and DEF bones, but Blender constraints are gone. Prefer the
  // equivalent weighted deform bone so the visible mesh actually moves.
  const key = anatomicalBoneKey(shortName);
  let candidates = skinBoneCandidates(rig,key);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1){
    const nearest = nearestCandidateToControl(rig,direct,candidates);
    if (nearest) return nearest;
  }

  // Finger naming differs heavily between Blender rigs and FBX exports
  // (Finger_Index1 vs f_index.01, Thumb2 vs thumb.02, etc.).
  const finger = findFingerDeformBone(rig,shortName);
  if (finger) return finger;

  // Rigify/CloudRig often split arm/leg deform bones into .001/.002 chains.
  // Those suffixes caused perfectly valid limbs to be marked invalid.
  candidates = segmentedDeformCandidates(rig,shortName);
  if (candidates.length){
    const nearest = nearestCandidateToControl(rig,direct,candidates);
    if (nearest) return nearest;
  }

  // A few rigs use pelvis rather than hips.
  if (key === "hips"){
    candidates = [
      ...skinBoneCandidates(rig,"pelvis"),
      ...skinBoneCandidates(rig,"hip")
    ];
    const unique = [...new Set(candidates)];
    if (unique.length === 1) return unique[0];

    // CloudRig/Sintel often uses the lowest DEF-spine as the pelvis/root
    // deform bone rather than a bone literally named hips/pelvis.
    const weightedSpine = rig.bones
      .filter(b => deformNames.has(b.name) && anatomicalBoneKey(b.name).startsWith("spine"))
      .sort((a,b) => (rig.rest.get(a.name)?.depth ?? 0) - (rig.rest.get(b.name)?.depth ?? 0));
    if (weightedSpine.length) return weightedSpine[0];
  }

  // Spine/chest naming frequently uses numbered deform bones.
  const side = /([lr])$/.exec(key)?.[1] || "";
  if (key.includes("chest")){
    const spineBones = rig.bones
      .filter(b => {
        if (!deformNames.has(b.name)) return false;
        const k = anatomicalBoneKey(b.name);
        return k.includes("chest") || k.startsWith("spine");
      })
      .sort((a,b) => (rig.rest.get(a.name)?.depth ?? 0) - (rig.rest.get(b.name)?.depth ?? 0));
    // Chest is the uppermost/deepest torso deform before neck/head.
    if (spineBones.length) return spineBones[spineBones.length - 1];
  }

  if (key === "spine" || key.startsWith("spine")){
    const exactish = rig.bones
      .filter(b => {
        if (!deformNames.has(b.name)) return false;
        const k = anatomicalBoneKey(b.name);
        return k === key;
      });
    if (exactish.length === 1) return exactish[0];

    const spineBones = rig.bones
      .filter(b => deformNames.has(b.name) && anatomicalBoneKey(b.name).startsWith("spine"))
      .sort((a,b) => (rig.rest.get(a.name)?.depth ?? 0) - (rig.rest.get(b.name)?.depth ?? 0));
    if (spineBones.length){
      // FK-Spine means the lower torso; numbered spine targets retain their
      // numeric index where possible.
      const idx = Number((key.match(/spine(\d+)/) || [])[1]);
      if (Number.isFinite(idx)){
        const byIndex = spineBones.find(b => anatomicalBoneKey(b.name) === `spine${idx}`);
        if (byIndex) return byIndex;
      }
      return spineBones[0];
    }
  }

  if (key.includes("shoulder")){
    const fuzzy = rig.bones.filter(b => {
      if (!deformNames.has(b.name)) return false;
      const k = anatomicalBoneKey(b.name);
      if (side && !k.endsWith(side)) return false;
      return k.includes("shoulder");
    });
    if (fuzzy.length === 1) return fuzzy[0];
  }

  // If a direct control exists but has neither vertex influence nor weighted
  // descendants, returning it would create a successful-looking bake that
  // never moves the visible mesh. Mark it unresolved instead.
  return null;
}

export function countValidPairs(pairs, sourceRig, targetRig, sourcePrefix="", targetPrefix=""){
  let valid = 0;
  let redirected = 0;
  for (const p of pairs || []){
    const source = resolveBone(sourceRig,p.source,sourcePrefix);
    const directTarget = resolveBone(targetRig,p.target,targetPrefix);
    const target = resolveRetargetTargetBone(targetRig,p.target,targetPrefix);
    if (source && target){
      valid++;
      if (directTarget && target !== directTarget) redirected++;
    }
  }
  return {valid,total:(pairs || []).length,redirected};
}

function targetCandidateMap(targetRig){
  const exact = new Map();
  const canonical = new Map();
  for (const b of targetRig?.bones || []){
    exact.set(b.name.toLowerCase(),b.name);
    const c = normalizeBoneName(b.name);
    if (!canonical.has(c)) canonical.set(c,[]);
    canonical.get(c).push(b.name);
  }
  return {exact,canonical};
}

export function autoMatchPairs(sourceRig, targetRig, sourcePrefix="", targetPrefix=""){
  if (!sourceRig || !targetRig) return [];
  const {canonical} = targetCandidateMap(targetRig);
  const pairs = [];

  for (const src of sourceRig.bones){
    let sourceShort = stripKnownPrefix(src.name, sourcePrefix);
    let direct = targetRig.boneMap.get(targetPrefix + sourceShort) || targetRig.boneMap.get(sourceShort);
    let targetName = direct?.name || "";

    if (!targetName){
      const c = normalizeBoneName(sourceShort);
      const hits = canonical.get(c) || [];
      if (hits.length === 1) targetName = hits[0];
      else if (hits.length > 1){
        const pref = hits.find(n => targetPrefix && n.startsWith(targetPrefix));
        targetName = pref || hits[0];
      }
    }
    if (!targetName) continue;

    const targetShort = stripKnownPrefix(targetName, targetPrefix);
    const c = normalizeBoneName(sourceShort);
    let channels = "ROT";
    if (/^(root|hips|pelvis)$/.test(c)) channels = "LOC_ROT";
    pairs.push({
      source: sourceShort,
      target: targetShort,
      channels,
      axes:"XYZ",
      loc_space:"BASIS",
      influence:1
    });
  }
  return pairs;
}

function bodyBoneNames(rig){
  if (rig?.weightedBoneNames?.size) return rig.weightedBoneNames;
  if (rig?.skinBoneNames?.size) return rig.skinBoneNames;
  return new Set(rig?.boneNames || []);
}

function bodyHeight(rig,restMap){
  if (!rig || !restMap?.size) return 1;
  const names = bodyBoneNames(rig);
  const ys = [];
  for (const name of names){
    const r = restMap.get(name);
    if (!r) continue;
    const y = r.worldPosition.y;
    if (Number.isFinite(y)) ys.push(y);
  }
  if (ys.length < 2) return 1;
  ys.sort((a,b)=>a-b);

  // Ignore extreme accessory/control outliers even if they happen to carry
  // tiny skin weights. 5–95% is stable for humanoid body scale.
  const lo = ys[Math.floor((ys.length-1)*0.05)];
  const hi = ys[Math.ceil((ys.length-1)*0.95)];
  return Math.max(Math.abs(hi-lo),EPS);
}

function median(values){
  const a = values.filter(Number.isFinite).sort((x,y)=>x-y);
  if (!a.length) return null;
  const m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1]+a[m])*0.5;
}

function robustRetargetScale(records,sourceRig,targetRig,sourceRest){
  // Prefer scale inferred from corresponding mapped body landmarks. This
  // avoids CloudRig pole/control bones making the target hundreds of times
  // "larger" than the visible character.
  const bodyRecords = records.filter(r => r.sourceBone && r.targetBone && !r.targetRoot);
  const hipsRecord = bodyRecords.find(r => {
    const s = normalizeBoneName(r.source);
    return (s === "hips" || s === "pelvis") && pairHasRotation(r);
  }) || bodyRecords.find(r => {
    const s = normalizeBoneName(r.source);
    return s === "hips" || s === "pelvis";
  });

  const ratios = [];
  if (hipsRecord){
    const srcAnchor = sourceRest.get(hipsRecord.sourceBone.name)?.worldPosition;
    const tgtAnchor = targetRig.rest.get(hipsRecord.targetBone.name)?.worldPosition;
    if (srcAnchor && tgtAnchor){
      const usedTargets = new Set();
      for (const r of bodyRecords){
        if (usedTargets.has(r.targetBone.name)) continue;
        usedTargets.add(r.targetBone.name);

        const sr = sourceRest.get(r.sourceBone.name);
        const tr = targetRig.rest.get(r.targetBone.name);
        if (!sr || !tr) continue;

        const ds = sr.worldPosition.distanceTo(srcAnchor);
        const dt = tr.worldPosition.distanceTo(tgtAnchor);
        if (ds < EPS || dt < EPS) continue;

        const ratio = dt/ds;
        if (Number.isFinite(ratio) && ratio > 1e-4 && ratio < 1e4){
          ratios.push(ratio);
        }
      }
    }
  }

  if (ratios.length >= 4){
    // Median rejects a wrongly-resolved limb or an accessory bone.
    const value = median(ratios);
    if (value && Number.isFinite(value)){
      return {value,method:"mapped-landmarks",samples:ratios.length};
    }
  }

  const sourceHeight = bodyHeight(sourceRig,sourceRest);
  const targetHeight = bodyHeight(targetRig,targetRig.rest);
  const value = targetHeight/sourceHeight;
  return {
    value:Number.isFinite(value) && value > EPS ? value : 1,
    method:"weighted-height",
    samples:0
  };
}

function quatScaledDelta(poseQ, restQ, factor){
  const delta = poseQ.clone().multiply(restQ.clone().invert()).normalize();
  if (delta.w < 0){
    delta.x *= -1; delta.y *= -1; delta.z *= -1; delta.w *= -1;
  }
  const w = THREE.MathUtils.clamp(delta.w,-1,1);
  let angle = 2 * Math.acos(w);
  let s = Math.sqrt(Math.max(EPS,1 - w*w));
  let axis;
  if (s < 1e-5){
    axis = new THREE.Vector3(1,0,0);
    angle = 0;
  } else {
    axis = new THREE.Vector3(delta.x/s,delta.y/s,delta.z/s).normalize();
  }
  return new THREE.Quaternion().setFromAxisAngle(axis, angle * factor).normalize();
}

function pairMotionScale(pair, faceSettings){
  const explicit = Number(pair.loc_scale ?? 1);
  if (Number.isFinite(explicit) && Math.abs(explicit - 1) > 1e-6) return explicit;
  const region = faceRegionFromSource(pair.source);
  if (!region) return 1;
  if (faceSettings?.perRegion){
    const value = Number(faceSettings.regions?.[region] ?? 1);
    return Number.isFinite(value) ? value : 1;
  }
  const global = Number(faceSettings?.global ?? 1);
  return Number.isFinite(global) ? global : 1;
}

function quaternionFromWXYZ(v){
  if (!Array.isArray(v) || v.length !== 4) return null;
  const q = new THREE.Quaternion(Number(v[1]),Number(v[2]),Number(v[3]),Number(v[0]));
  return Number.isFinite(q.lengthSq()) && q.lengthSq() > EPS ? q.normalize() : null;
}

function quaternionToWXYZ(q){
  return [q.w,q.x,q.y,q.z];
}

function cloneRestEntry(base){
  return {
    ...base,
    world:base.world.clone(),
    worldPosition:base.worldPosition.clone(),
    worldQuaternion:base.worldQuaternion.clone(),
    worldScale:base.worldScale.clone(),
    position:base.position.clone(),
    quaternion:base.quaternion.clone(),
    scale:base.scale.clone(),
    externalParentWorld:base.externalParentWorld?.clone?.() || base.externalParentWorld || null
  };
}

function armatureWorldMatrix(rig){
  rig.root.updateMatrixWorld(true);
  // FBXLoader commonly wraps the actual skeleton/armature node inside the
  // returned Group. BlendCap rest-pose data is armature-local, so use the
  // non-bone parent of a root bone rather than assuming the top FBX Group
  // itself is the armature coordinate frame.
  const rootBone = rig.bones.find(b => !b.parent?.isBone) || rig.bones[0];
  if (rootBone?.parent?.matrixWorld) return rootBone.parent.matrixWorld.clone();
  return rig.root.matrixWorld.clone();
}

function rootWorldComponents(rig){
  const matrix = armatureWorldMatrix(rig);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position,quaternion,scale);
  return {position,quaternion,scale,matrix};
}

function worldDeltaFromPreset(rig,savedRestQ,savedPoseQ){
  // BlendCap stores armature-local absolute rotations. Convert the saved
  // pose change into a delta first, then carry that delta through the FBX
  // root orientation into Three.js world space. This is also the native
  // path for web-saved presets, which use root-local coordinates.
  const deltaLocal = savedPoseQ.clone().multiply(savedRestQ.clone().invert()).normalize();
  const rootQ = rootWorldComponents(rig).quaternion;
  return rootQ.clone().multiply(deltaLocal).multiply(rootQ.clone().invert()).normalize();
}

function entryMapForRig(rig,preset,sourcePrefix=""){
  const out = new Map();
  const bones = preset?.bones || {};
  for (const [name,entry] of Object.entries(bones)){
    const bone = resolveBone(rig,name,sourcePrefix);
    if (bone) out.set(bone.name,entry);
  }
  return out;
}

export function buildRestOverrideFromPreset(sourceRig,preset,{
  sourcePrefix="",
  includeLocScale=Boolean(preset?.include_loc_scale)
}={}){
  if (!sourceRig || !preset?.bones) return sourceRig?.rest || new Map();

  const entries = entryMapForRig(sourceRig,preset,sourcePrefix);
  const result = new Map();
  const armatureWorld = armatureWorldMatrix(sourceRig);
  const rootInv = armatureWorld.clone().invert();
  const rootWorld = armatureWorld;
  const rootScale = rootWorldComponents(sourceRig).scale;

  for (const bone of sourceRig.bones){
    const base = sourceRig.rest.get(bone.name);
    const item = cloneRestEntry(base);
    const entry = entries.get(bone.name);
    if (!entry || typeof entry !== "object"){
      result.set(bone.name,item);
      continue;
    }

    let desiredWorldQ = base.worldQuaternion.clone();
    const savedRestQ = quaternionFromWXYZ(entry.rest);
    const savedPoseQ = quaternionFromWXYZ(entry.pose);
    if (savedRestQ && savedPoseQ){
      const deltaWorld = worldDeltaFromPreset(sourceRig,savedRestQ,savedPoseQ);
      desiredWorldQ = deltaWorld.multiply(base.worldQuaternion.clone()).normalize();
    }

    let desiredWorldPos = base.worldPosition.clone();
    let desiredWorldScale = base.worldScale.clone();

    if (includeLocScale){
      if (Array.isArray(entry.loc) && entry.loc.length === 3){
        desiredWorldPos = new THREE.Vector3(
          Number(entry.loc[0]),Number(entry.loc[1]),Number(entry.loc[2])
        ).applyMatrix4(rootWorld);
      }
      if (Array.isArray(entry.scale) && entry.scale.length === 3){
        desiredWorldScale = new THREE.Vector3(
          Number(entry.scale[0]) * rootScale.x,
          Number(entry.scale[1]) * rootScale.y,
          Number(entry.scale[2]) * rootScale.z
        );
      }
    }

    item.worldPosition = desiredWorldPos;
    item.worldQuaternion = desiredWorldQ;
    item.worldScale = desiredWorldScale;
    item.world = new THREE.Matrix4().compose(
      desiredWorldPos.clone(),desiredWorldQ.clone(),desiredWorldScale.clone()
    );

    // For rotation-only overrides BlendCap deliberately keeps the live
    // edit-rest translation/scale. Full v5 presets can override all three.
    if (includeLocScale){
      const parentWorld = bone.parent?.isBone
        ? sourceRig.rest.get(bone.parent.name).world
        : (base.externalParentWorld || new THREE.Matrix4());
      const local = parentWorld.clone().invert().multiply(item.world);
      local.decompose(item.position,item.quaternion,item.scale);
    } else {
      item.position.copy(base.position);
      item.scale.copy(base.scale);
      const parentWorld = bone.parent?.isBone
        ? sourceRig.rest.get(bone.parent.name).world
        : (base.externalParentWorld || new THREE.Matrix4());
      const parentQ = decomposeWorld(parentWorld).quaternion;
      item.quaternion.copy(parentQ.clone().invert().multiply(desiredWorldQ).normalize());
    }
    result.set(bone.name,item);
  }
  return result;
}

function sourceRestForBake(sourceRig,useCurrentSourcePoseAsRest,includeLocScale=false){
  if (!useCurrentSourcePoseAsRest) return sourceRig.rest;

  sourceRig.root.updateMatrixWorld(true);
  const map = new Map();
  for (const bone of sourceRig.bones){
    const base = sourceRig.rest.get(bone.name);
    const wd = decomposeWorld(bone.matrixWorld);
    const desiredPos = includeLocScale ? wd.position : base.worldPosition;
    const desiredScale = includeLocScale ? wd.scale : base.worldScale;
    const world = new THREE.Matrix4().compose(
      desiredPos.clone(),wd.quaternion.clone(),desiredScale.clone()
    );
    const item = cloneRestEntry(base);
    item.world = world;
    item.worldPosition = desiredPos.clone();
    item.worldQuaternion = wd.quaternion.clone();
    item.worldScale = desiredScale.clone();
    item.quaternion.copy(bone.quaternion);
    if (includeLocScale){
      item.position.copy(bone.position);
      item.scale.copy(bone.scale);
    }
    map.set(bone.name,item);
  }
  return map;
}

export function previewRestPosePreset(sourceRig,preset,{
  sourcePrefix="",
  includeLocScale=Boolean(preset?.include_loc_scale)
}={}){
  if (!sourceRig || !preset?.bones) return 0;
  resetRigToRest(sourceRig);
  const entries = entryMapForRig(sourceRig,preset,sourcePrefix);
  const desired = buildRestOverrideFromPreset(sourceRig,preset,{sourcePrefix,includeLocScale});
  const sorted = [...sourceRig.bones].sort((a,b) =>
    sourceRig.rest.get(a.name).depth - sourceRig.rest.get(b.name).depth
  );

  let applied = 0;
  for (const bone of sorted){
    const base = sourceRig.rest.get(bone.name);
    const entry = entries.get(bone.name);
    if (!entry){
      bone.position.copy(base.position);
      bone.quaternion.copy(base.quaternion);
      bone.scale.copy(base.scale);
      bone.updateMatrix();
      sourceRig.root.updateMatrixWorld(true);
      continue;
    }

    const target = desired.get(bone.name);
    const parentWorld = bone.parent?.matrixWorld || new THREE.Matrix4();
    const parentInv = parentWorld.clone().invert();

    // Absolute desired world matrix -> local pose under the parent as it
    // currently stands. This mirrors BlendCap's parent-before-child preview.
    const local = parentInv.multiply(target.world.clone());
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    local.decompose(pos,quat,scale);

    bone.quaternion.copy(quat);
    if (includeLocScale){
      bone.position.copy(pos);
      bone.scale.copy(scale);
    } else {
      bone.position.copy(base.position);
      bone.scale.copy(base.scale);
    }
    bone.updateMatrix();
    sourceRig.root.updateMatrixWorld(true);
    applied++;
  }
  sourceRig.activeClip = null;
  sourceRig.activeAction = null;
  return applied;
}

export function captureRestPosePreset(sourceRig,{
  name="Web Rest Pose",
  includeLocScale=false,
  sourcePrefix=""
}={}){
  if (!sourceRig) throw new Error("No hay Source Rig.");
  sourceRig.root.updateMatrixWorld(true);
  const rootInv = armatureWorldMatrix(sourceRig).invert();
  const bones = {};

  for (const bone of sourceRig.bones){
    const base = sourceRig.rest.get(bone.name);
    const restArm = rootInv.clone().multiply(base.world);
    const poseArm = rootInv.clone().multiply(bone.matrixWorld);
    const restD = decomposeWorld(restArm);
    const poseD = decomposeWorld(poseArm);

    const rotDelta = Math.abs(restD.quaternion.dot(poseD.quaternion));
    const posDelta = restD.position.distanceTo(poseD.position);
    const scaleDelta = restD.scale.distanceTo(poseD.scale);
    const changed = (1 - rotDelta) > 1e-7
      || (includeLocScale && (posDelta > 1e-7 || scaleDelta > 1e-7));
    if (!changed) continue;

    const entry = {
      rest:quaternionToWXYZ(restD.quaternion),
      pose:quaternionToWXYZ(poseD.quaternion)
    };
    entry.loc = [poseD.position.x,poseD.position.y,poseD.position.z];
    entry.scale = [poseD.scale.x,poseD.scale.y,poseD.scale.z];
    bones[stripKnownPrefix(bone.name,sourcePrefix)] = entry;
  }

  return {
    name,
    format_version:5,
    include_loc_scale:Boolean(includeLocScale),
    web_coordinate_system:"three-root-local",
    bones
  };
}

function restForResolved(restMap, bone){
  return bone ? restMap.get(bone.name) : null;
}

function vectorToLocal(parentWorld, worldPos){
  return worldPos.clone().applyMatrix4(parentWorld.clone().invert());
}

function parentWorldForBone(bone, worldOut, restEntry){
  if (bone.parent?.isBone){
    return worldOut.get(bone.parent.name) || bone.parent.matrixWorld;
  }
  return restEntry.externalParentWorld || new THREE.Matrix4();
}

function buildWorldFromLocal(parentWorld, pos, quat, scale){
  const local = new THREE.Matrix4().compose(pos,quat,scale);
  return parentWorld.clone().multiply(local);
}

function pairHasRotation(pair){
  if (pair?._location_only) return false;
  if (pair?._rotation_only) return true;
  if (pair?.set_as_root) return true;
  const c = String(pair.channels || "ROT").toUpperCase();
  return c === "ROT" || c === "LOC_ROT";
}

function pairHasLocation(pair){
  if (pair?._rotation_only) return false;
  if (pair?._location_only) return true;
  if (pair?.set_as_root) return true;
  const c = String(pair.channels || "ROT").toUpperCase();
  return c === "LOC" || c === "LOC_ROT";
}

function axesFor(pair){
  const a = String(pair.axes || "XYZ").toUpperCase();
  return {x:a.includes("X"),y:a.includes("Y"),z:a.includes("Z")};
}

function applyAxesAdd(dst, contribution, axes){
  if (axes.x) dst.x += contribution.x;
  if (axes.y) dst.y += contribution.y;
  if (axes.z) dst.z += contribution.z;
}

function shortestQuatInPlace(q, prev){
  if (prev && prev.dot(q) < 0){
    q.x *= -1; q.y *= -1; q.z *= -1; q.w *= -1;
  }
  return q;
}

function mappedPairLookup(pairs){
  const byTarget = new Map();
  for (const p of pairs){
    if (!p.target) continue;
    if (!byTarget.has(p.target)) byTarget.set(p.target,[]);
    byTarget.get(p.target).push(p);
  }
  return byTarget;
}

function findPairBySource(pairs, wanted){
  const wc = normalizeBoneName(wanted);
  return (pairs || []).find(p => normalizeBoneName(p.source) === wc) || null;
}

function computeFaceScale(sourceRig,targetRig,pairs,sourcePrefix,targetPrefix,sourceRest,targetRest,srcHead,tgtHead){
  if (!srcHead || !tgtHead) return null;
  const leftPair = findPairBySource(pairs,"LeftEye");
  const rightPair = findPairBySource(pairs,"RightEye");
  if (!leftPair || !rightPair) return null;

  const srcL = resolveBone(sourceRig,leftPair.source,sourcePrefix);
  const srcR = resolveBone(sourceRig,rightPair.source,sourcePrefix);
  const tgtL = resolveBone(targetRig,leftPair.target,targetPrefix);
  const tgtR = resolveBone(targetRig,rightPair.target,targetPrefix);
  if (!srcL || !srcR || !tgtL || !tgtR) return null;

  const srcHeadRest = sourceRest.get(srcHead.name)?.world;
  const tgtHeadRest = targetRest.get(tgtHead.name)?.world;
  if (!srcHeadRest || !tgtHeadRest) return null;

  const srcInv = srcHeadRest.clone().invert();
  const tgtInv = tgtHeadRest.clone().invert();
  const sL = sourceRest.get(srcL.name).worldPosition.clone().applyMatrix4(srcInv);
  const sR = sourceRest.get(srcR.name).worldPosition.clone().applyMatrix4(srcInv);
  const tL = targetRest.get(tgtL.name).worldPosition.clone().applyMatrix4(tgtInv);
  const tR = targetRest.get(tgtR.name).worldPosition.clone().applyMatrix4(tgtInv);
  const sd = sL.distanceTo(sR);
  const td = tL.distanceTo(tR);
  if (sd < EPS || td < EPS) return null;
  const ratio = td / sd;
  return Number.isFinite(ratio) && ratio > 0.05 && ratio < 20 ? ratio : null;
}

function isGlobalRootLocationPair(pair){
  if (pair?.set_as_root) return false;
  if (!pairHasLocation(pair)) return false;
  const source = normalizeBoneName(pair.source);
  if (source !== "hips" && source !== "pelvis") return false;

  const target = String(pair.target || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g,"");

  // BlendCap/CloudRig splits Mixamo Hips translation between TORSO-Spine Z
  // and root XY. In an FBX those controls have no Blender constraints.
  // Applying their translation to a weighted spine bone stretches the mesh,
  // so these channels must move the whole imported Target object instead.
  return target === "root" || target === "torsospine";
}

function rootMotionSourceForBone(sourceRig,bone){
  // If Auto-Rig Pro marks a torso bone as Root, using that bone's world
  // position also includes the rotational sweep inherited from the pelvis.
  // For FBX root translation, prefer the nearest pelvis/root ancestor.
  let current = bone;
  while (current?.isBone){
    const key = normalizeBoneName(current.name);
    if (key === "hips" || key === "pelvis" || key === "root") return current;
    current = current.parent?.isBone ? current.parent : null;
  }
  return bone;
}

function horizontalYawDeltaFromBone(bone,restEntry){
  if (!bone || !restEntry) return new THREE.Quaternion();

  const worldUp = new THREE.Vector3(0,1,0);
  const axes = [
    new THREE.Vector3(0,0,1),
    new THREE.Vector3(1,0,0),
    new THREE.Vector3(0,1,0)
  ];

  // Pick the bone-local axis that is most horizontal in the rest pose.
  // We only need a stable heading axis: the signed delta is identical
  // whether that horizontal axis points forward or sideways.
  let localHeading = axes[0];
  let best = -1;
  for (const axis of axes){
    const worldAxis = axis.clone().applyQuaternion(restEntry.worldQuaternion);
    const horizontal = worldAxis.clone().setY(0);
    const score = horizontal.lengthSq();
    if (score > best){
      best = score;
      localHeading = axis;
    }
  }

  const restHeading = localHeading.clone()
    .applyQuaternion(restEntry.worldQuaternion)
    .setY(0);
  const poseWorldQ = new THREE.Quaternion();
  bone.matrixWorld.decompose(
    new THREE.Vector3(),
    poseWorldQ,
    new THREE.Vector3()
  );
  const poseHeading = localHeading.clone()
    .applyQuaternion(poseWorldQ)
    .setY(0);

  if (restHeading.lengthSq() < 1e-8 || poseHeading.lengthSq() < 1e-8){
    return new THREE.Quaternion();
  }

  restHeading.normalize();
  poseHeading.normalize();

  const cross = restHeading.clone().cross(poseHeading);
  const dot = THREE.MathUtils.clamp(restHeading.dot(poseHeading),-1,1);
  const angle = Math.atan2(cross.dot(worldUp),dot);

  return new THREE.Quaternion().setFromAxisAngle(worldUp,angle);
}

function actualPairRecords(pairs,sourceRig,targetRig,sourcePrefix,targetPrefix){
  const out = [];

  for (let pairIndex=0; pairIndex<(pairs || []).length; pairIndex++){
    const raw = pairs[pairIndex];
    const sourceBone = resolveBone(sourceRig,raw.source,sourcePrefix);
    if (!sourceBone) continue;

    if (isGlobalRootLocationPair(raw)){
      out.push({
        ...raw,
        pairIndex,
        sourceBone,
        targetBone:null,
        targetRoot:true,
        _location_only:true,
        sourceRest:sourceRig.rest.get(sourceBone.name),
        targetRest:null
      });
      continue;
    }

    const sourceKey = normalizeBoneName(raw.source);
    const isPelvisSource = sourceKey === "hips" || sourceKey === "pelvis";
    const hasPelvisLocation = isPelvisSource && pairHasLocation(raw) && !raw.set_as_root;

    if (hasPelvisLocation){
      const targetBone = resolveRetargetTargetBone(
        targetRig,
        raw.target,
        targetPrefix
      );
      if (!targetBone) continue;

      // Rotation stays on the actual pelvis deform bone.
      if (pairHasRotation(raw)){
        out.push({
          ...raw,
          pairIndex,
          channels:"ROT",
          _rotation_only:true,
          sourceBone,
          targetBone,
          targetRoot:false,
          sourceRest:sourceRig.rest.get(sourceBone.name),
          targetRest:targetRig.rest.get(targetBone.name)
        });
      }

      // Translation moves the whole Target object. This is critical for
      // exported control rigs: translating DEF-Hips alone pulls only part of
      // the weighted hierarchy while clothing/accessory branches remain at
      // bind, producing the long spikes visible in the viewport.
      out.push({
        ...raw,
        pairIndex,
        channels:"LOC",
        _location_only:true,
        _pelvis_translation_to_root:true,
        sourceBone,
        targetBone:null,
        targetRoot:true,
        sourceRest:sourceRig.rest.get(sourceBone.name),
        targetRest:null
      });
      continue;
    }

    if (raw.set_as_root){
      // Auto-Rig Pro "Set as Root" is the global motion reference. In Blender
      // it targets TORSO-Spine through rig constraints; in plain FBX those
      // constraints are gone. The faithful browser analogue is:
      //   ROT -> whole Target object
      //   LOC -> whole Target object
      // Pelvis articulation remains on Hips -> HIP-Spine -> DEF-Hips.
      const rootTargetExists = resolveBone(targetRig,raw.target,targetPrefix)
        || resolveRetargetTargetBone(targetRig,raw.target,targetPrefix);
      if (!rootTargetExists) continue;

      const rootSource = rootMotionSourceForBone(sourceRig,sourceBone);

      out.push({
        ...raw,
        pairIndex,
        channels:"ROT",
        axes:"Y",
        _rotation_only:true,
        _root_rotation:true,
        _yaw_only:true,
        sourceBone:rootSource,
        targetBone:null,
        targetRoot:true,
        sourceRest:sourceRig.rest.get(rootSource.name),
        targetRest:null
      });

      out.push({
        ...raw,
        pairIndex,
        set_as_root:false,
        channels:"LOC",
        axes:"XZ",
        _location_only:true,
        _root_horizontal:true,
        sourceBone:rootSource,
        targetBone:null,
        targetRoot:true,
        sourceRest:sourceRig.rest.get(rootSource.name),
        targetRest:null
      });
      continue;
    }

    const targetBone = resolveRetargetTargetBone(
      targetRig,
      raw.target,
      targetPrefix
    );
    if (!targetBone) continue;

    out.push({
      ...raw,
      pairIndex,
      sourceBone,
      targetBone,
      targetRoot:false,
      sourceRest:sourceRig.rest.get(sourceBone.name),
      targetRest:targetRig.rest.get(targetBone.name)
    });
  }
  return out;
}

function makeTrackName(boneName, property){
  return `${boneName}.${property}`;
}

function pushQuat(values,q){
  values.push(q.x,q.y,q.z,q.w);
}
function pushVec(values,v){
  values.push(v.x,v.y,v.z);
}

export async function bakeRetarget(options){
  const {
    sourceRig,targetRig,sourceClip,pairs=[],
    sourcePrefix="",targetPrefix="",
    fps=30,autoScale=true,useCurrentSourcePoseAsRest=false,
    restPosePreset=null,includeRestLocationScale=false,
    useWorldLocation=false,headSource="",headTarget="",
    correctHands=true,correctFeet=true,
    faceSettings={global:1,perRegion:false,regions:{}},
    onProgress
  } = options || {};

  if (!sourceRig || !targetRig) throw new Error("Falta Source o Target.");
  if (!sourceClip) throw new Error("El Source no tiene un clip seleccionado.");
  if (!pairs.length) throw new Error("El bone map está vacío.");

  // Clear any non-destructive custom-rest preview before sampling the clip.
  // FBX clips do not necessarily key every bone/channel, so leaving preview
  // transforms in place would contaminate unkeyed channels.
  resetRigToRest(sourceRig);
  activateClip(sourceRig,sourceClip);
  // The current source pose must already be positioned by the caller if it
  // wants to use it as the rest baseline. activateClip starts at t=0, so
  // restore the requested preview time when provided.
  if (Number.isFinite(options.sourceRestTime)){
    setRigTime(sourceRig,options.sourceRestTime);
  }
  const sourceRest = restPosePreset
    ? buildRestOverrideFromPreset(sourceRig,restPosePreset,{
        sourcePrefix,
        includeLocScale:Boolean(includeRestLocationScale)
      })
    : sourceRestForBake(
        sourceRig,
        useCurrentSourcePoseAsRest,
        Boolean(includeRestLocationScale)
      );

  const records = actualPairRecords(pairs,sourceRig,targetRig,sourcePrefix,targetPrefix);
  if (!records.length) throw new Error("Ningún par del mapa existe en ambos FBX.");

  // Return source to frame zero for the actual bake.
  setRigTime(sourceRig,0);

  const scaleInfo = autoScale
    ? robustRetargetScale(records,sourceRig,targetRig,sourceRest)
    : {value:1,method:"disabled",samples:0};
  const locationScale = scaleInfo.value;
  const step = 1 / Math.max(1,Number(fps) || 30);
  const duration = Math.max(0,sourceClip.duration || 0);
  const frameCount = Math.max(2,Math.floor(duration / step + 0.5) + 1);
  const times = new Array(frameCount);
  for (let i=0;i<frameCount;i++) times[i] = Math.min(duration,i*step);
  times[frameCount-1] = duration;

  const rootRotationRecords = records.filter(r => r.targetRoot && pairHasRotation(r));
  const rootLocationRecords = records.filter(r => r.targetRoot && pairHasLocation(r));
  const boneRecords = records.filter(r => !r.targetRoot && r.targetBone);

  const targetByActual = new Map();
  for (const r of boneRecords){
    if (!targetByActual.has(r.targetBone.name)) targetByActual.set(r.targetBone.name,[]);
    targetByActual.get(r.targetBone.name).push(r);
  }

  const rotationTargets = new Set();
  const locationTargets = new Set();
  for (const r of boneRecords){
    if (pairHasRotation(r)) rotationTargets.add(r.targetBone.name);
    if (pairHasLocation(r)) locationTargets.add(r.targetBone.name);
  }

  // Build a virtual anatomical hierarchy from the SOURCE mappings. Exported
  // control rigs often do not preserve their Blender constraint hierarchy in
  // FBX: e.g. DEF-Head can live under a static STR/P-STR branch instead of
  // following DEF-Neck directly. Rotations alone then look close, but joints
  // appear to "disconnect". We compensate by keying mapped deform positions
  // so every mapped child follows the nearest mapped source ancestor.
  const sourceToTarget = new Map();
  const sourceRecordByName = new Map();
  for (const r of boneRecords){
    if (!r.sourceBone || !r.targetBone || !pairHasRotation(r)) continue;
    if (!sourceToTarget.has(r.sourceBone.name)){
      sourceToTarget.set(r.sourceBone.name,r.targetBone.name);
      sourceRecordByName.set(r.sourceBone.name,r);
    }
  }

  const virtualParentByTarget = new Map();
  const virtualRestOffsetByTarget = new Map();
  const virtualSourceDepthByTarget = new Map();
  const naturallyConnectedVirtualTargets = [];

  function isActualBoneAncestor(ancestorName,childName){
    const child = targetRig.boneMap.get(childName);
    let p = child?.parent;
    while (p?.isBone){
      if (p.name === ancestorName) return true;
      p = p.parent;
    }
    return false;
  }

  for (const r of sourceRecordByName.values()){
    const childTarget = r.targetBone.name;
    let parent = r.sourceBone.parent;
    let parentTarget = null;

    while (parent?.isBone){
      const candidate = sourceToTarget.get(parent.name);
      if (candidate && candidate !== childTarget){
        parentTarget = candidate;
        break;
      }
      parent = parent.parent;
    }

    if (!parentTarget) continue;
    const childRest = targetRig.rest.get(childTarget);
    const parentRest = targetRig.rest.get(parentTarget);
    if (!childRest || !parentRest) continue;

    // If the mapped anatomical parent is already an actual ancestor in the
    // exported FBX (possibly through twist segments such as
    // DEF-UpperArm_1 -> DEF-UpperArm_2 -> DEF-Forearm_1), natural parenting
    // already keeps the chain connected. Adding position tracks here bends
    // or stretches the deform chain twice. Only synthesize a positional link
    // when the FBX hierarchy is genuinely disconnected.
    if (isActualBoneAncestor(parentTarget,childTarget)){
      naturallyConnectedVirtualTargets.push(childTarget);
      continue;
    }

    virtualParentByTarget.set(childTarget,parentTarget);
    virtualRestOffsetByTarget.set(
      childTarget,
      childRest.worldPosition.clone().sub(parentRest.worldPosition)
    );
    virtualSourceDepthByTarget.set(
      childTarget,
      sourceRest.get(r.sourceBone.name)?.depth ?? 0
    );

    // Position tracks are required even when the original map was ROT-only:
    // they emulate the missing Blender constraints/parenting in the FBX.
    locationTargets.add(childTarget);
  }

  const virtualTargets = [...virtualParentByTarget.keys()].sort(
    (a,b) => (virtualSourceDepthByTarget.get(a) ?? 0)
      - (virtualSourceDepthByTarget.get(b) ?? 0)
  );

  // Pure FK preserves rotations, but different humanoids can have very
  // different upper-arm/forearm proportions. That makes the wrist drift
  // visibly even when the joint rotations are technically correct. Build a
  // lightweight two-bone end-effector correction from Source hand position.
  const useArmEndEffectorCorrection = Boolean(
    correctHands && !targetRig.cloudRigProfile
  );
  const armCorrectionChains = [];
  if (useArmEndEffectorCorrection){
    for (const side of ["Left","Right"]){
      const sUpper = resolveBone(sourceRig,`${side}Arm`,sourcePrefix);
      const sMid = resolveBone(sourceRig,`${side}ForeArm`,sourcePrefix);
      const sEnd = resolveBone(sourceRig,`${side}Hand`,sourcePrefix);
      if (!sUpper || !sMid || !sEnd) continue;

      const tUpperName = sourceToTarget.get(sUpper.name);
      const tMidName = sourceToTarget.get(sMid.name);
      const tEndName = sourceToTarget.get(sEnd.name);
      if (!tUpperName || !tMidName || !tEndName) continue;

      const sUpperRest = sourceRest.get(sUpper.name);
      const sMidRest = sourceRest.get(sMid.name);
      const sEndRest = sourceRest.get(sEnd.name);
      const tUpperRest = targetRig.rest.get(tUpperName);
      const tMidRest = targetRig.rest.get(tMidName);
      const tEndRest = targetRig.rest.get(tEndName);
      if (!sUpperRest || !sMidRest || !sEndRest
        || !tUpperRest || !tMidRest || !tEndRest) continue;

      const sourceUpperLen = sUpperRest.worldPosition.distanceTo(sMidRest.worldPosition);
      const sourceForeLen = sMidRest.worldPosition.distanceTo(sEndRest.worldPosition);
      const targetUpperLen = tUpperRest.worldPosition.distanceTo(tMidRest.worldPosition);
      const targetForeLen = tMidRest.worldPosition.distanceTo(tEndRest.worldPosition);
      const sourceReach = sourceUpperLen + sourceForeLen;
      const targetReach = targetUpperLen + targetForeLen;
      if (sourceReach < EPS || targetReach < EPS) continue;

      armCorrectionChains.push({
        side,
        sUpper,sMid,sEnd,
        tUpperName,tMidName,tEndName,
        sourceUpperLen,sourceForeLen,
        targetUpperLen,targetForeLen,
        reachScale:targetReach/sourceReach
      });
    }
  }

  const footCorrectionChains = [];
  if (correctFeet){
    for (const side of ["Left","Right"]){
      const sUpper = resolveBone(sourceRig,`${side}UpLeg`,sourcePrefix);
      const sMid = resolveBone(sourceRig,`${side}Leg`,sourcePrefix);
      const sEnd = resolveBone(sourceRig,`${side}Foot`,sourcePrefix);
      if (!sUpper || !sMid || !sEnd) continue;

      const tUpperName = sourceToTarget.get(sUpper.name);
      const tMidName = sourceToTarget.get(sMid.name);
      const tEndName = sourceToTarget.get(sEnd.name);
      if (!tUpperName || !tMidName || !tEndName) continue;

      const sUpperRest = sourceRest.get(sUpper.name);
      const sMidRest = sourceRest.get(sMid.name);
      const sEndRest = sourceRest.get(sEnd.name);
      const tUpperRest = targetRig.rest.get(tUpperName);
      const tMidRest = targetRig.rest.get(tMidName);
      const tEndRest = targetRig.rest.get(tEndName);
      if (!sUpperRest || !sMidRest || !sEndRest
        || !tUpperRest || !tMidRest || !tEndRest) continue;

      const sourceUpperLen = sUpperRest.worldPosition.distanceTo(sMidRest.worldPosition);
      const sourceForeLen = sMidRest.worldPosition.distanceTo(sEndRest.worldPosition);
      const targetUpperLen = tUpperRest.worldPosition.distanceTo(tMidRest.worldPosition);
      const targetForeLen = tMidRest.worldPosition.distanceTo(tEndRest.worldPosition);
      const sourceReach = sourceUpperLen + sourceForeLen;
      const targetReach = targetUpperLen + targetForeLen;
      if (sourceReach < EPS || targetReach < EPS) continue;

      // Reproduce the useful part of the Mixamo control-rig retarget in
      // HIPS POSE SPACE. A plain Hips→Foot world vector is insufficient:
      // when the pelvis pitches/rolls during Sit To Stand the vector rotates
      // around a moving pivot. The Blender addon avoids that by copying
      // transforms in POSE space after rebasing the Source rest pose.
      //
      // We represent the same information without physically creating helper
      // bones:
      //   SourceRelPose = inverse(SourceHipsPose) * SourceFootPose
      //   SourceDelta   = SourceRelPose * inverse(SourceRelRest)
      //   TargetRelPose = scaled(SourceDelta) * TargetRelRest
      //   TargetFoot    = TargetHipsPose * TargetRelPose
      const sHips = resolveBone(sourceRig,"Hips",sourcePrefix)
        || resolveBone(sourceRig,"Pelvis",sourcePrefix);
      const tHipsName = sHips ? sourceToTarget.get(sHips.name) : null;
      const sHipsRest = sHips ? sourceRest.get(sHips.name) : null;
      const tHipsRest = tHipsName ? targetRig.rest.get(tHipsName) : null;

      let sourceFootRelRest = null;
      let sourceKneeRelRest = null;
      let targetFootRelRest = null;
      let targetKneeRelRest = null;
      let pelvisFootScale = targetReach/sourceReach;
      let pelvisKneeScale = targetUpperLen/Math.max(sourceUpperLen,EPS);

      if (sHipsRest && tHipsRest){
        const srcHipsRestInv = sHipsRest.world.clone().invert();
        const tgtHipsRestInv = tHipsRest.world.clone().invert();

        sourceFootRelRest = srcHipsRestInv.clone().multiply(sEndRest.world);
        sourceKneeRelRest = srcHipsRestInv.clone().multiply(sMidRest.world);
        targetFootRelRest = tgtHipsRestInv.clone().multiply(tEndRest.world);
        targetKneeRelRest = tgtHipsRestInv.clone().multiply(tMidRest.world);

        const srcFootRestPos = new THREE.Vector3().setFromMatrixPosition(sourceFootRelRest);
        const tgtFootRestPos = new THREE.Vector3().setFromMatrixPosition(targetFootRelRest);
        const srcKneeRestPos = new THREE.Vector3().setFromMatrixPosition(sourceKneeRelRest);
        const tgtKneeRestPos = new THREE.Vector3().setFromMatrixPosition(targetKneeRelRest);

        if (srcFootRestPos.length() > EPS && tgtFootRestPos.length() > EPS){
          pelvisFootScale = tgtFootRestPos.length()/srcFootRestPos.length();
        }
        if (srcKneeRestPos.length() > EPS && tgtKneeRestPos.length() > EPS){
          pelvisKneeScale = tgtKneeRestPos.length()/srcKneeRestPos.length();
        }
      }

      footCorrectionChains.push({
        kind:"LEG",
        side,
        sUpper,sMid,sEnd,sHips,
        tUpperName,tMidName,tEndName,tHipsName,
        sourceUpperLen,sourceForeLen,
        targetUpperLen,targetForeLen,
        reachScale:targetReach/sourceReach,
        sourceFootRelRest,
        sourceKneeRelRest,
        targetFootRelRest,
        targetKneeRelRest,
        pelvisFootScale,
        pelvisKneeScale
      });
    }
  }

  const limbCorrectionChains = [
    ...armCorrectionChains.map(chain => ({...chain,kind:"ARM"})),
    ...footCorrectionChains
  ];

  const sortedBones = [...targetRig.bones].sort((a,b) =>
    targetRig.rest.get(a.name).depth - targetRig.rest.get(b.name).depth
  );

  const qValues = new Map();
  const pValues = new Map();
  const rootPValues = rootLocationRecords.length ? [] : null;
  const rootQValues = rootRotationRecords.length ? [] : null;
  const previousQ = new Map();
  let previousRootQ = null;
  for (const n of rotationTargets) qValues.set(n,[]);
  for (const n of locationTargets) pValues.set(n,[]);

  let srcHeadBone = headSource ? resolveBone(sourceRig,headSource,sourcePrefix) : null;
  let tgtHeadBone = headTarget ? resolveBone(targetRig,headTarget,targetPrefix) : null;
  if (!srcHeadBone){
    srcHeadBone = resolveBone(sourceRig,"Head",sourcePrefix)
      || sourceRig.bones.find(b => normalizeBoneName(b.name) === "head") || null;
  }
  if (!tgtHeadBone){
    const mappedHead = findPairBySource(pairs,"Head");
    tgtHeadBone = mappedHead ? resolveBone(targetRig,mappedHead.target,targetPrefix) : null;
    tgtHeadBone ||= resolveBone(targetRig,"head",targetPrefix)
      || targetRig.bones.find(b => normalizeBoneName(b.name) === "head") || null;
  }

  const faceScale = computeFaceScale(
    sourceRig,targetRig,pairs,sourcePrefix,targetPrefix,
    sourceRest,targetRig.rest,srcHeadBone,tgtHeadBone
  ) || locationScale;

  const srcHeadRest = srcHeadBone ? sourceRest.get(srcHeadBone.name) : null;
  const tgtHeadRest = tgtHeadBone ? targetRig.rest.get(tgtHeadBone.name) : null;
  const srcHeadRestInv = srcHeadRest?.world.clone().invert() || null;
  const tgtHeadRestInv = tgtHeadRest?.world.clone().invert() || null;
  const headCorrectionQ = srcHeadRest && tgtHeadRest
    ? tgtHeadRest.worldQuaternion.clone().invert().multiply(srcHeadRest.worldQuaternion)
    : new THREE.Quaternion();

  const localState = new Map();
  const worldOut = new Map();

  function rebuildWorldOut(){
    worldOut.clear();
    for (const bone of sortedBones){
      const rest = targetRig.rest.get(bone.name);
      const state = localState.get(bone.name);
      if (!rest || !state) continue;
      const parentWorld = parentWorldForBone(bone,worldOut,rest);
      worldOut.set(
        bone.name,
        buildWorldFromLocal(
          parentWorld,
          state.position,
          state.quaternion,
          state.scale
        )
      );
    }
  }

  function worldPositionOf(name){
    const m = worldOut.get(name);
    return m ? new THREE.Vector3().setFromMatrixPosition(m) : null;
  }

  function worldQuaternionOf(name){
    const m = worldOut.get(name);
    if (!m) return null;
    const q = new THREE.Quaternion();
    m.decompose(new THREE.Vector3(),q,new THREE.Vector3());
    return q;
  }

  function setBoneWorldQuaternion(name,desiredWorldQ){
    const bone = targetRig.boneMap.get(name);
    const rest = targetRig.rest.get(name);
    const state = localState.get(name);
    if (!bone || !rest || !state) return false;
    const parentWorld = parentWorldForBone(bone,worldOut,rest);
    const parentQ = new THREE.Quaternion();
    parentWorld.decompose(new THREE.Vector3(),parentQ,new THREE.Vector3());
    state.quaternion.copy(
      parentQ.invert().multiply(desiredWorldQ).normalize()
    );
    return true;
  }

  for (let frame=0;frame<frameCount;frame++){
    const t = times[frame];
    setRigTime(sourceRig,t);

    localState.clear();
    worldOut.clear();

    // Global locomotion must move the whole Target object, not a deform
    // spine bone. Otherwise vertices partially weighted to unmapped
    // hair/clothing bones are pulled into huge spikes.
    let rootLocalPos = targetRig.rootRest?.position.clone()
      || targetRig.root.position.clone();
    for (const r of rootLocationRecords){
      const srcRest = sourceRest.get(r.sourceBone.name);
      if (!srcRest) continue;

      const currentWorldPos = new THREE.Vector3()
        .setFromMatrixPosition(r.sourceBone.matrixWorld);
      const deltaWorld = currentWorldPos.sub(srcRest.worldPosition);
      const contribution = deltaWorld.multiplyScalar(
        locationScale
        * pairMotionScale(r,faceSettings)
        * Number(r.influence ?? 1)
      );
      applyAxesAdd(rootLocalPos,contribution,axesFor(r));
    }
    if (rootPValues) pushVec(rootPValues,rootLocalPos);

    // Global root rotation. This was the missing half of Set-as-Root:
    // previous builds animated only root position, so the character moved
    // through space but did not turn with the Source.
    let rootDeltaQ = new THREE.Quaternion(); // identity
    let rootLocalQuat = targetRig.rootRest?.quaternion.clone()
      || targetRig.root.quaternion.clone();

    for (const r of rootRotationRecords){
      const srcRest = sourceRest.get(r.sourceBone.name);
      if (!srcRest) continue;

      const motionScale = pairMotionScale(r,faceSettings)
        * Number(r.influence ?? 1);

      let deltaQ;
      if (r._yaw_only){
        const yaw = horizontalYawDeltaFromBone(r.sourceBone,srcRest);
        deltaQ = new THREE.Quaternion().slerp(yaw,motionScale).normalize();
      } else {
        const srcPoseQ = new THREE.Quaternion();
        r.sourceBone.matrixWorld.decompose(
          new THREE.Vector3(),
          srcPoseQ,
          new THREE.Vector3()
        );
        deltaQ = quatScaledDelta(
          srcPoseQ,
          srcRest.worldQuaternion,
          motionScale
        );
      }

      rootDeltaQ.multiply(deltaQ).normalize();
    }

    if (rootQValues){
      rootLocalQuat = rootDeltaQ
        .clone()
        .multiply(targetRig.rootRest?.quaternion || targetRig.root.quaternion)
        .normalize();
      shortestQuatInPlace(rootLocalQuat,previousRootQ);
      previousRootQ = rootLocalQuat.clone();
      pushQuat(rootQValues,rootLocalQuat);
    }

    // Bone tracks are baked in the Target's static-root frame. Because the
    // object itself now carries root rotation, remove that global rotation
    // from each source world delta before deriving the bone-local pose. This
    // prevents double rotation while preserving pelvis/spine articulation.
    const rootDeltaInv = rootRotationRecords.length
      ? rootDeltaQ.clone().invert()
      : null;

    // PASS 1: rest locals + regular BASIS/WORLD location + world-delta rotation.
    for (const bone of sortedBones){
      const rest = targetRig.rest.get(bone.name);
      const localPos = rest.position.clone();
      let localQuat = rest.quaternion.clone();
      const localScale = rest.scale.clone();
      const recs = targetByActual.get(bone.name) || [];

      // Regular location contributions compose per-axis.
      for (const r of recs){
        if (!pairHasLocation(r)) continue;
        if (String(r.loc_space || "BASIS").toUpperCase() === "HEAD_LOCAL") continue;
        const srcBone = r.sourceBone;
        const srcRest = sourceRest.get(srcBone.name);
        const motionScale = pairMotionScale(r,faceSettings) * Number(r.influence ?? 1);
        let contribution;

        if (useWorldLocation){
          const currentWorldPos = new THREE.Vector3().setFromMatrixPosition(srcBone.matrixWorld);
          const deltaWorld = currentWorldPos.sub(srcRest.worldPosition);
          contribution = deltaWorld.applyQuaternion(rest.worldQuaternion.clone().invert());
        } else {
          const sourceLocalDelta = srcBone.position.clone().sub(srcRest.position);
          const locFrameQ = rest.worldQuaternion.clone().invert().multiply(srcRest.worldQuaternion);
          contribution = sourceLocalDelta.applyQuaternion(locFrameQ);
        }

        contribution.multiplyScalar(locationScale * motionScale);
        applyAxesAdd(localPos,contribution,axesFor(r));
      }

      const rotRecs = recs.filter(pairHasRotation);
      let desiredWorldQ = null;
      let composedLocalQ = null;

      if (rotRecs.length === 1 && !rotRecs[0].set_as_root){
        // Normal one-to-one mapping: keep BlendCap's world-space
        // delta-from-rest transfer.
        const rotRec = rotRecs[0];
        const srcRest = sourceRest.get(rotRec.sourceBone.name);
        const srcPoseQ = new THREE.Quaternion();
        rotRec.sourceBone.matrixWorld.decompose(
          new THREE.Vector3(),
          srcPoseQ,
          new THREE.Vector3()
        );
        const motionScale = pairMotionScale(rotRec,faceSettings)
          * Number(rotRec.influence ?? 1);
        let deltaQ = quatScaledDelta(
          srcPoseQ,
          srcRest.worldQuaternion,
          motionScale
        );
        if (rootDeltaInv){
          deltaQ = rootDeltaInv.clone().multiply(deltaQ).normalize();
        }
        desiredWorldQ = deltaQ
          .multiply(rest.worldQuaternion.clone())
          .normalize();
      } else if (rotRecs.length){
        // FBX control rigs can collapse several Blender controls onto one
        // weighted deform proxy. Example from this CloudRig:
        //   Hips  -> HIP-Spine   -> DEF-Hips
        //   Spine -> TORSO-Spine -> DEF-Hips (Set as Root)
        // Previously only the FIRST row was used, so Spine/TORSO rotation
        // was silently discarded. Compose the source LOCAL deltas instead.
        let combinedDelta = new THREE.Quaternion(); // identity
        for (const rotRec of rotRecs){
          const srcRest = sourceRest.get(rotRec.sourceBone.name);
          if (!srcRest) continue;
          const motionScale = pairMotionScale(rotRec,faceSettings)
            * Number(rotRec.influence ?? 1);
          const deltaLocal = quatScaledDelta(
            rotRec.sourceBone.quaternion,
            srcRest.quaternion,
            motionScale
          );
          combinedDelta.multiply(deltaLocal).normalize();
        }
        composedLocalQ = combinedDelta
          .multiply(rest.quaternion.clone())
          .normalize();
      }

      const parentWorld = parentWorldForBone(bone,worldOut,rest);
      if (composedLocalQ){
        localQuat = composedLocalQ;
      } else if (desiredWorldQ){
        const parentQ = new THREE.Quaternion();
        parentWorld.decompose(
          new THREE.Vector3(),
          parentQ,
          new THREE.Vector3()
        );
        localQuat = parentQ
          .invert()
          .multiply(desiredWorldQ)
          .normalize();
      }

      localState.set(bone.name,{position:localPos,quaternion:localQuat,scale:localScale});
      worldOut.set(bone.name,buildWorldFromLocal(parentWorld,localPos,localQuat,localScale));
    }

    // PASS 1B: virtual-chain positional stabilization.
    // Preserve each Target's own rest proportions, but make mapped children
    // follow the mapped anatomical parent rather than a static CloudRig
    // control/STR branch left behind by FBX export.
    for (const childName of virtualTargets){
      const parentName = virtualParentByTarget.get(childName);
      const childBone = targetRig.boneMap.get(childName);
      const childRest = targetRig.rest.get(childName);
      const parentRest = targetRig.rest.get(parentName);
      const parentDesiredWorld = worldOut.get(parentName);
      const childState = localState.get(childName);
      if (!childBone || !childRest || !parentRest || !parentDesiredWorld || !childState) continue;

      const parentPos = new THREE.Vector3();
      const parentQ = new THREE.Quaternion();
      const parentScale = new THREE.Vector3();
      parentDesiredWorld.decompose(parentPos,parentQ,parentScale);

      const parentDeltaQ = parentQ.clone()
        .multiply(parentRest.worldQuaternion.clone().invert())
        .normalize();

      const restOffset = virtualRestOffsetByTarget.get(childName).clone();
      const desiredWorldPos = parentPos.add(restOffset.applyQuaternion(parentDeltaQ));

      const actualParentWorld = parentWorldForBone(childBone,worldOut,childRest);
      childState.position.copy(vectorToLocal(actualParentWorld,desiredWorldPos));

      worldOut.set(
        childName,
        buildWorldFromLocal(
          actualParentWorld,
          childState.position,
          childState.quaternion,
          childState.scale
        )
      );
    }

    // PASS 1C: two-bone end-effector correction for arms and legs.
    // Match Source wrist/ankle position normalized by total limb reach, then
    // solve the Target elbow/knee using the Source bend plane. Only rotations
    // are changed: CloudRig DEF local translations remain untouched.
    for (const chain of limbCorrectionChains){
      const srcA = new THREE.Vector3().setFromMatrixPosition(chain.sUpper.matrixWorld);
      const srcB = new THREE.Vector3().setFromMatrixPosition(chain.sMid.matrixWorld);
      const srcC = new THREE.Vector3().setFromMatrixPosition(chain.sEnd.matrixWorld);

      let srcAC = srcC.clone().sub(srcA);
      let srcAB = srcB.clone().sub(srcA);
      if (rootDeltaInv){
        srcAC.applyQuaternion(rootDeltaInv);
        srcAB.applyQuaternion(rootDeltaInv);
      }

      const A = worldPositionOf(chain.tUpperName);
      const currentB = worldPositionOf(chain.tMidName);
      const currentC = worldPositionOf(chain.tEndName);
      const originalHandQ = worldQuaternionOf(chain.tEndName);
      if (!A || !currentB || !currentC || !originalHandQ) continue;
      if (srcAC.lengthSq() < EPS || srcAB.lengthSq() < EPS) continue;

      let desiredC = null;
      let desiredKneeReference = null;
      let desiredEndWorldQ = originalHandQ;

      if (
        chain.kind === "LEG"
        && chain.sHips
        && chain.tHipsName
        && chain.sourceFootRelRest
        && chain.sourceKneeRelRest
        && chain.targetFootRelRest
        && chain.targetKneeRelRest
      ){
        const targetHipsWorld = worldOut.get(chain.tHipsName);
        if (targetHipsWorld){
          // Source leg matrices in pelvis pose space. This automatically
          // removes armature/root translation and Hips rotation instead of
          // trying to subtract them as unrelated channels.
          const srcHipsPoseInv = chain.sHips.matrixWorld.clone().invert();
          const srcFootRelPose = srcHipsPoseInv.clone().multiply(chain.sEnd.matrixWorld);
          const srcKneeRelPose = srcHipsPoseInv.clone().multiply(chain.sMid.matrixWorld);

          const footDelta = srcFootRelPose.clone()
            .multiply(chain.sourceFootRelRest.clone().invert());
          const kneeDelta = srcKneeRelPose.clone()
            .multiply(chain.sourceKneeRelRest.clone().invert());

          // Rebase the full delta onto Target proportions. Scale only the
          // translational component; preserve the quaternion exactly.
          function scaledPoseDelta(delta,scale){
            const p = new THREE.Vector3();
            const q = new THREE.Quaternion();
            const s = new THREE.Vector3();
            delta.decompose(p,q,s);
            p.multiplyScalar(scale);
            return new THREE.Matrix4().compose(
              p,
              q.normalize(),
              new THREE.Vector3(1,1,1)
            );
          }

          const targetFootRelPose = scaledPoseDelta(
            footDelta,
            chain.pelvisFootScale
          ).multiply(chain.targetFootRelRest.clone());

          const targetKneeRelPose = scaledPoseDelta(
            kneeDelta,
            chain.pelvisKneeScale
          ).multiply(chain.targetKneeRelRest.clone());

          const desiredFootWorld = targetHipsWorld.clone()
            .multiply(targetFootRelPose);
          const desiredKneeWorld = targetHipsWorld.clone()
            .multiply(targetKneeRelPose);

          desiredC = new THREE.Vector3().setFromMatrixPosition(desiredFootWorld);
          desiredKneeReference = new THREE.Vector3()
            .setFromMatrixPosition(desiredKneeWorld);

          desiredEndWorldQ = new THREE.Quaternion();
          desiredFootWorld.decompose(
            new THREE.Vector3(),
            desiredEndWorldQ,
            new THREE.Vector3()
          );
          desiredEndWorldQ.normalize();
        }
      }

      // Fallback for rigs where a usable Hips pose space cannot be built.
      if (!desiredC){
        desiredC = A.clone().add(srcAC.multiplyScalar(chain.reachScale));
      }

      let AC = desiredC.clone().sub(A);
      let d = AC.length();
      if (d < EPS) continue;

      const minReach = Math.abs(chain.targetUpperLen-chain.targetForeLen) + 1e-5;
      const maxReach = chain.targetUpperLen+chain.targetForeLen - 1e-5;
      const clampedD = THREE.MathUtils.clamp(d,minReach,maxReach);
      if (Math.abs(clampedD-d) > 1e-7){
        desiredC = A.clone().add(AC.normalize().multiplyScalar(clampedD));
        AC = desiredC.clone().sub(A);
        d = clampedD;
      }

      const dir = AC.clone().normalize();
      const a = (
        chain.targetUpperLen*chain.targetUpperLen
        - chain.targetForeLen*chain.targetForeLen
        + d*d
      )/(2*d);
      const hSq = Math.max(
        0,
        chain.targetUpperLen*chain.targetUpperLen - a*a
      );
      const h = Math.sqrt(hSq);
      const base = A.clone().add(dir.clone().multiplyScalar(a));

      // Source elbow plane, expressed in the static-root frame.
      const srcBC = srcC.clone().sub(srcB);
      if (rootDeltaInv) srcBC.applyQuaternion(rootDeltaInv);
      let planeN = srcAB.clone().cross(srcBC);
      if (planeN.lengthSq() < EPS){
        planeN = currentB.clone().sub(A).cross(currentC.clone().sub(currentB));
      }
      if (planeN.lengthSq() < EPS){
        planeN.set(0,0,1);
      }
      planeN.normalize();

      let perp = planeN.clone().cross(dir);
      if (perp.lengthSq() < EPS){
        perp = new THREE.Vector3(0,1,0).cross(dir);
      }
      if (perp.lengthSq() < EPS){
        perp = new THREE.Vector3(1,0,0).cross(dir);
      }
      perp.normalize();

      const candidate1 = base.clone().add(perp.clone().multiplyScalar(h));
      const candidate2 = base.clone().add(perp.clone().multiplyScalar(-h));
      const sourceMidReference = desiredKneeReference || A.clone().add(
        srcAB.clone().multiplyScalar(
          chain.targetUpperLen/Math.max(chain.sourceUpperLen,EPS)
        )
      );
      const desiredB = candidate1.distanceToSquared(sourceMidReference)
        <= candidate2.distanceToSquared(sourceMidReference)
        ? candidate1
        : candidate2;

      // Swing the target upper arm so the elbow reaches desiredB while
      // retaining the existing FK twist as much as possible.
      const upperWorldQ = worldQuaternionOf(chain.tUpperName);
      const upperPos = worldPositionOf(chain.tUpperName);
      const midPosBefore = worldPositionOf(chain.tMidName);
      if (!upperWorldQ || !upperPos || !midPosBefore) continue;

      const curUpperDir = midPosBefore.clone().sub(upperPos);
      const wantedUpperDir = desiredB.clone().sub(upperPos);
      if (curUpperDir.lengthSq() > EPS && wantedUpperDir.lengthSq() > EPS){
        const swing = new THREE.Quaternion().setFromUnitVectors(
          curUpperDir.normalize(),
          wantedUpperDir.normalize()
        );
        setBoneWorldQuaternion(
          chain.tUpperName,
          swing.multiply(upperWorldQ).normalize()
        );
        rebuildWorldOut();
      }

      // Do NOT translate DEF-Forearm / DEF-Hand. In CloudRig the deform
      // chain contains intermediate twist bones (_1/_2). Their bind-space
      // translations define the real limb lengths. Moving mapped DEF joints
      // directly bends/stretches that chain twice. Let hierarchy propagation
      // move the elbow naturally after the upper-arm swing.
      const foreWorldQ = worldQuaternionOf(chain.tMidName);
      const midPos = worldPositionOf(chain.tMidName);
      const endPosBefore = worldPositionOf(chain.tEndName);
      if (foreWorldQ && midPos && endPosBefore){
        const curForeDir = endPosBefore.clone().sub(midPos);
        const wantedForeDir = desiredC.clone().sub(midPos);
        if (curForeDir.lengthSq() > EPS && wantedForeDir.lengthSq() > EPS){
          const swing = new THREE.Quaternion().setFromUnitVectors(
            curForeDir.normalize(),
            wantedForeDir.normalize()
          );
          setBoneWorldQuaternion(
            chain.tMidName,
            swing.multiply(foreWorldQ).normalize()
          );
          rebuildWorldOut();
        }
      }

      // Preserve the hand's FK world orientation after the parent rotations.
      // Position is inherited naturally through DEF-Forearm_2 -> DEF-Hand.
      const endBone = targetRig.boneMap.get(chain.tEndName);
      const endRest = targetRig.rest.get(chain.tEndName);
      const endState = localState.get(chain.tEndName);
      if (!endBone || !endRest || !endState) continue;
      const endParentWorld = parentWorldForBone(endBone,worldOut,endRest);
      const endParentQ = new THREE.Quaternion();
      endParentWorld.decompose(
        new THREE.Vector3(),
        endParentQ,
        new THREE.Vector3()
      );
      endState.quaternion.copy(
        endParentQ.invert().multiply(desiredEndWorldQ).normalize()
      );
      rebuildWorldOut();
    }

    // PASS 2: HEAD_LOCAL rows. These intentionally bypass the target's
    // semantic parent chain and land the control at a head-relative point.
    if (srcHeadBone && tgtHeadBone && srcHeadRestInv && tgtHeadRestInv){
      const srcHeadPoseInv = srcHeadBone.matrixWorld.clone().invert();
      const tgtHeadWorld = worldOut.get(tgtHeadBone.name) || tgtHeadBone.matrixWorld;

      for (const [targetName,recs] of targetByActual){
        const hl = recs.filter(r => pairHasLocation(r)
          && String(r.loc_space || "BASIS").toUpperCase() === "HEAD_LOCAL");
        if (!hl.length) continue;

        const targetBone = targetRig.boneMap.get(targetName);
        const targetRest = targetRig.rest.get(targetName);
        const state = localState.get(targetName);
        const parentWorld = parentWorldForBone(targetBone,worldOut,targetRest);

        for (const r of hl){
          const srcRest = sourceRest.get(r.sourceBone.name);
          const srcCurrentWorldPos = new THREE.Vector3().setFromMatrixPosition(r.sourceBone.matrixWorld);
          const srcCurrentHeadLocal = srcCurrentWorldPos.clone().applyMatrix4(srcHeadPoseInv);
          const srcRestHeadLocal = srcRest.worldPosition.clone().applyMatrix4(srcHeadRestInv);
          const motion = srcCurrentHeadLocal.sub(srcRestHeadLocal).applyQuaternion(headCorrectionQ);

          const targetRestHeadLocal = targetRest.worldPosition.clone().applyMatrix4(tgtHeadRestInv);
          const motionScale = pairMotionScale(r,faceSettings) * Number(r.influence ?? 1);
          const desiredHeadLocal = targetRestHeadLocal.add(motion.multiplyScalar(faceScale * motionScale));
          const desiredWorld = desiredHeadLocal.applyMatrix4(tgtHeadWorld);
          const desiredLocal = vectorToLocal(parentWorld,desiredWorld);
          const delta = desiredLocal.sub(targetRest.position);
          applyAxesAdd(state.position,delta,axesFor(r));
        }
      }

      // Rebuild world matrices because head-local controls may be parents of
      // additional bones/controllers.
      worldOut.clear();
      for (const bone of sortedBones){
        const rest = targetRig.rest.get(bone.name);
        const state = localState.get(bone.name);
        const parentWorld = parentWorldForBone(bone,worldOut,rest);
        worldOut.set(bone.name,buildWorldFromLocal(
          parentWorld,state.position,state.quaternion,state.scale
        ));
      }
    }

    for (const n of rotationTargets){
      const q = localState.get(n).quaternion.clone().normalize();
      shortestQuatInPlace(q,previousQ.get(n));
      previousQ.set(n,q.clone());
      pushQuat(qValues.get(n),q);
    }
    for (const n of locationTargets){
      pushVec(pValues.get(n),localState.get(n).position);
    }

    if (onProgress && (frame % Math.max(1,Math.floor(frameCount/100)) === 0 || frame === frameCount-1)){
      onProgress((frame+1)/frameCount,`Retargeting ${frame+1}/${frameCount}`);
      await new Promise(requestAnimationFrame);
    }
  }

  const tracks = [];
  for (const [name,values] of qValues){
    tracks.push(new THREE.QuaternionKeyframeTrack(makeTrackName(name,"quaternion"),times,values));
  }
  for (const [name,values] of pValues){
    tracks.push(new THREE.VectorKeyframeTrack(makeTrackName(name,"position"),times,values));
  }
  if (rootPValues){
    const rootTrackName = targetRig.root.name
      ? makeTrackName(targetRig.root.name,"position")
      : ".position";
    tracks.push(new THREE.VectorKeyframeTrack(rootTrackName,times,rootPValues));
  }
  if (rootQValues){
    const rootTrackName = targetRig.root.name
      ? makeTrackName(targetRig.root.name,"quaternion")
      : ".quaternion";
    tracks.push(new THREE.QuaternionKeyframeTrack(rootTrackName,times,rootQValues));
  }

  const clip = new THREE.AnimationClip("Retargeted",duration,tracks);
  clip.resetDuration();
  resetRigToRest(targetRig);
  activateClip(targetRig,clip);
  setRigTime(targetRig,0);
  setRigTime(sourceRig,0);

  return {
    clip,
    validPairs:new Set(records.map(r => r.pairIndex)).size,
    totalPairs:pairs.length,
    frameCount,
    locationScale,
    locationScaleMethod:scaleInfo.method,
    locationScaleSamples:scaleInfo.samples,
    rootMotionChannels:rootLocationRecords.length,
    rootMotionSources:[...new Set(rootLocationRecords.map(r => r.sourceBone?.name).filter(Boolean))],
    rootRotationChannels:rootRotationRecords.length,
    rootRotationSources:[...new Set(rootRotationRecords.map(r => r.sourceBone?.name).filter(Boolean))],
    rootRotationMode:rootRotationRecords.some(r => r._yaw_only)
      ? "pelvis-yaw-only"
      : "full-quaternion",
    rootTranslationMode:rootLocationRecords.some(r => r._pelvis_translation_to_root)
      ? "pelvis-translation-on-target-object"
      : rootLocationRecords.some(r => r._root_horizontal)
        ? "horizontal-XZ-only"
        : "mapped-axes",
    pelvisTranslationRedirectedToRoot:rootLocationRecords.some(
      r => r._pelvis_translation_to_root
    ),
    virtualChainStabilizedTargets:virtualTargets,
    virtualChainStabilizedCount:virtualTargets.length,
    naturalHierarchyTargets:naturallyConnectedVirtualTargets,
    naturalHierarchyTargetCount:naturallyConnectedVirtualTargets.length,
    handEndEffectorCorrection:useArmEndEffectorCorrection,
    handCorrectionMode:targetRig.cloudRigProfile
      ? "blendcap-world-delta-only"
      : (useArmEndEffectorCorrection ? "two-bone" : "disabled"),
    handEndEffectorChains:armCorrectionChains.map(c => ({
      side:c.side,
      sourceUpper:c.sourceUpperLen,
      sourceFore:c.sourceForeLen,
      targetUpper:c.targetUpperLen,
      targetFore:c.targetForeLen,
      reachScale:c.reachScale
    })),
    limbBendPlaneMode:"source-plane",
    footEndEffectorCorrection:Boolean(correctFeet),
    footEndEffectorChains:footCorrectionChains.map(c => ({
      side:c.side,
      sourceThigh:c.sourceUpperLen,
      sourceShin:c.sourceForeLen,
      targetThigh:c.targetUpperLen,
      targetShin:c.targetForeLen,
      reachScale:c.reachScale,
      pelvisFootScale:c.pelvisFootScale,
      targetMode:(c.sHips && c.tHipsName && c.sourceFootRelRest && c.targetFootRelRest)
        ? "hips-pose-space-matrix"
        : "thigh-relative-fallback"
    })),
    splitRootMappings:[...new Set(records
      .filter(r => r._rotation_only || r._location_only)
      .map(r => r.pairIndex))]
      .map(i => pairs[i])
      .filter(Boolean)
      .map(p => `${p.source}→${p.target}`),
    collapsedRotationTargets:[...targetByActual.entries()]
      .filter(([,recs]) => recs.filter(pairHasRotation).length > 1)
      .map(([name,recs]) => ({
        target:name,
        sources:recs.filter(pairHasRotation).map(r => r.source)
      })),
    faceScale
  };
}

function replaceTracks(baseTracks,newTracks){
  const keyed = new Map();
  for (const t of baseTracks) keyed.set(t.name,t);
  for (const t of newTracks) keyed.set(t.name,t);
  return [...keyed.values()];
}

function targetFromSourceCanonical(pairs,sourceName,targetRig,targetPrefix){
  const p = findPairBySource(pairs,sourceName);
  return p ? resolveRetargetTargetBone(targetRig,p.target,targetPrefix) : null;
}

function fallbackBoneByKeywords(rig,side,parts){
  const sideWords = side === "L" ? ["left",".l","_l","-l"] : ["right",".r","_r","-r"];
  const candidates = rig.bones.filter(b => {
    const n = b.name.toLowerCase();
    const sideOk = sideWords.some(s => n.includes(s));
    const partOk = parts.some(p => n.includes(p));
    return sideOk && partOk;
  });
  return candidates[0] || null;
}

function resolveIkFkChain(targetRig,pairs,targetPrefix,chain){
  const sideRaw = String(chain.side || "").toUpperCase();
  const side = sideRaw.startsWith("R") ? "R" : "L";
  const kind = String(chain.limb_kind || chain.kind || "ARM").toUpperCase().includes("LEG") ? "LEG" : "ARM";

  let upper,mid,end;
  if (kind === "ARM"){
    upper = targetFromSourceCanonical(pairs,side === "L" ? "LeftArm" : "RightArm",targetRig,targetPrefix);
    mid = targetFromSourceCanonical(pairs,side === "L" ? "LeftForeArm" : "RightForeArm",targetRig,targetPrefix);
    end = targetFromSourceCanonical(pairs,side === "L" ? "LeftHand" : "RightHand",targetRig,targetPrefix);
    upper ||= fallbackBoneByKeywords(targetRig,side,["upper_arm_fk","upperarm","arm_fk"]);
    mid ||= fallbackBoneByKeywords(targetRig,side,["forearm_fk","forearm","lowerarm"]);
    end ||= fallbackBoneByKeywords(targetRig,side,["hand_fk","hand"]);
  } else {
    upper = targetFromSourceCanonical(pairs,side === "L" ? "LeftUpLeg" : "RightUpLeg",targetRig,targetPrefix);
    mid = targetFromSourceCanonical(pairs,side === "L" ? "LeftLeg" : "RightLeg",targetRig,targetPrefix);
    end = targetFromSourceCanonical(pairs,side === "L" ? "LeftFoot" : "RightFoot",targetRig,targetPrefix);
    upper ||= fallbackBoneByKeywords(targetRig,side,["thigh_fk","thigh","upleg"]);
    mid ||= fallbackBoneByKeywords(targetRig,side,["shin_fk","shin","leg"]);
    end ||= fallbackBoneByKeywords(targetRig,side,["foot_fk","foot"]);
  }

  const control = resolveBone(targetRig,chain.ik_control || "",targetPrefix);
  const pole = resolveBone(targetRig,chain.pole_control || "",targetPrefix);
  return {side,kind,upper,mid,end,control,pole};
}

export async function bakeIkIntoClip(options){
  const {
    targetRig,clip,pairs=[],ikChains=[],
    targetPrefix="",fps=30,onProgress
  } = options || {};
  if (!targetRig || !clip) throw new Error("Primero aplica el retargeting FK.");
  if (!ikChains.length) throw new Error("No hay cadenas FK → IK configuradas.");

  activateClip(targetRig,clip);
  const step = 1 / Math.max(1,Number(fps) || 30);
  const duration = clip.duration;
  const frameCount = Math.max(2,Math.floor(duration/step + 0.5)+1);
  const times = new Array(frameCount);
  for (let i=0;i<frameCount;i++) times[i] = Math.min(duration,i*step);
  times[frameCount-1] = duration;

  const resolved = ikChains
    .map(c => ({raw:c,...resolveIkFkChain(targetRig,pairs,targetPrefix,c)}))
    .filter(c => c.upper && c.mid && c.end && (c.control || c.pole));

  if (!resolved.length) throw new Error("Las cadenas IK no resuelven controles/FK existentes en el Target FBX.");

  const out = new Map();
  function store(name,prop,size){
    const key = makeTrackName(name,prop);
    if (!out.has(key)) out.set(key,{name,key,prop,size,values:[]});
    return out.get(key);
  }

  for (let frame=0;frame<frameCount;frame++){
    setRigTime(targetRig,times[frame]);

    for (const c of resolved){
      if (c.control){
        const endRest = targetRig.rest.get(c.end.name);
        const ctrlRest = targetRig.rest.get(c.control.name);
        const desiredWorld = c.end.matrixWorld.clone()
          .multiply(endRest.world.clone().invert())
          .multiply(ctrlRest.world.clone());

        const parentWorld = c.control.parent?.matrixWorld || new THREE.Matrix4();
        const local = parentWorld.clone().invert().multiply(desiredWorld);
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        local.decompose(pos,quat,scale);
        pushVec(store(c.control.name,"position",3).values,pos);
        pushQuat(store(c.control.name,"quaternion",4).values,quat);
      }

      if (c.pole){
        const a = new THREE.Vector3().setFromMatrixPosition(c.upper.matrixWorld);
        const b = new THREE.Vector3().setFromMatrixPosition(c.mid.matrixWorld);
        const d = new THREE.Vector3().setFromMatrixPosition(c.end.matrixWorld);
        const ad = d.clone().sub(a);
        const denom = Math.max(EPS,ad.lengthSq());
        const projection = a.clone().add(ad.clone().multiplyScalar(
          b.clone().sub(a).dot(ad) / denom
        ));
        let dir = b.clone().sub(projection);
        if (dir.lengthSq() < EPS){
          const poleRest = targetRig.rest.get(c.pole.name).worldPosition;
          dir = poleRest.clone().sub(targetRig.rest.get(c.mid.name).worldPosition);
        }
        dir.normalize();

        const restDistance = targetRig.rest.get(c.pole.name).worldPosition.distanceTo(
          targetRig.rest.get(c.mid.name).worldPosition
        );
        const chainLength = a.distanceTo(b) + b.distanceTo(d);
        const distance = Math.max(restDistance,chainLength * 0.45,EPS);
        const desiredWorldPos = b.add(dir.multiplyScalar(distance));
        const parentWorld = c.pole.parent?.matrixWorld || new THREE.Matrix4();
        const localPos = vectorToLocal(parentWorld,desiredWorldPos);
        pushVec(store(c.pole.name,"position",3).values,localPos);
      }
    }

    if (onProgress && (frame % Math.max(1,Math.floor(frameCount/100)) === 0 || frame === frameCount-1)){
      onProgress((frame+1)/frameCount,`FK → IK ${frame+1}/${frameCount}`);
      await new Promise(requestAnimationFrame);
    }
  }

  const newTracks = [];
  for (const item of out.values()){
    if (item.prop === "quaternion"){
      // Enforce quaternion hemisphere continuity.
      for (let i=4;i<item.values.length;i+=4){
        const prev = new THREE.Quaternion().fromArray(item.values,i-4);
        const q = new THREE.Quaternion().fromArray(item.values,i);
        if (prev.dot(q) < 0){
          item.values[i]*=-1;item.values[i+1]*=-1;item.values[i+2]*=-1;item.values[i+3]*=-1;
        }
      }
      newTracks.push(new THREE.QuaternionKeyframeTrack(item.key,times,item.values));
    } else {
      newTracks.push(new THREE.VectorKeyframeTrack(item.key,times,item.values));
    }
  }

  const merged = new THREE.AnimationClip(
    "Retargeted_IK",
    duration,
    replaceTracks(clip.tracks,newTracks)
  );
  merged.resetDuration();
  resetRigToRest(targetRig);
  activateClip(targetRig,merged);
  setRigTime(targetRig,0);
  return {clip:merged,chains:resolved.length,frameCount};
}

export function serializeMap(config){
  return {
    name:config.name || "Custom Web Retarget Map",
    version:1,
    axis_convention:config.axis_convention || "THREE_Y_UP",
    target_kind:config.target_kind || "generic",
    source_prefix:config.sourcePrefix || "",
    namespace_strip:config.targetPrefix || "",
    auto_bake_ik:Boolean(config.autoBakeIk),
    face_head_source:config.headSource || "",
    face_head_target:config.headTarget || "",
    use_world_location:Boolean(config.useWorldLocation),
    face_amplification:{
      global:Number(config.faceSettings?.global ?? 1),
      ...(config.faceSettings?.regions || {})
    },
    ik_chains:(config.ikChains || []).map(c => ({
      limb_kind:c.limb_kind || "ARM",
      side:c.side || "L",
      owner:c.owner || "",
      ik_control:c.ik_control || "",
      pole_control:c.pole_control || ""
    })),
    pairs:(config.pairs || []).filter(p => p.source && p.target).map(p => {
      const out = {
        source:p.source,
        target:p.target,
        channels:p.channels || "ROT",
        influence:Number(p.influence ?? 1)
      };
      if (pairHasLocation(p)){
        out.axes = p.axes || "XYZ";
        if (String(p.loc_space || "BASIS").toUpperCase() !== "BASIS") out.loc_space = "head_local";
        if (Math.abs(Number(p.loc_scale ?? 1)-1) > 1e-6) out.loc_scale = Number(p.loc_scale);
      }
      if (p.set_as_root) out.set_as_root = true;
      return out;
    })
  };
}
