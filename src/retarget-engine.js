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
    fileName,
    bones,
    boneMap,
    boneNames: bones.map(b => b.name),
    skinBoneNames,
    weightedBoneNames,
    rest,
    animations: Array.isArray(root.animations) ? root.animations : [],
    mixer: new THREE.AnimationMixer(root),
    activeClip: null,
    activeAction: null,
    currentTime: 0
  };
  return rig;
}

export function resetRigToRest(rig){
  if (!rig) return;
  if (rig.mixer){
    rig.mixer.stopAllAction();
    rig.mixer.setTime(0);
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

export function resolveRetargetTargetBone(rig,shortName="",prefix=""){
  if (!rig || !shortName) return null;

  const direct = resolveBone(rig,shortName,prefix);
  const deformNames = deformBoneNameSet(rig);

  // Plain skeleton FBXs often skin directly to the mapped bone.
  if (!deformNames.size) return direct;

  // A control bone can be present in Skeleton.bones while having ZERO
  // vertex weight. Only accept it directly if it truly influences geometry.
  if (direct && deformNames.has(direct.name)) return direct;

  // Control-rig FBXs (Rigify/CloudRig/ARP) usually export both control
  // bones and DEF bones, but Blender constraints are gone. Prefer the
  // equivalent weighted deform bone so the visible mesh actually moves.
  const key = anatomicalBoneKey(shortName);
  let candidates = skinBoneCandidates(rig,key);
  if (candidates.length === 1) return candidates[0];

  // Finger naming differs heavily between Blender rigs and FBX exports
  // (Finger_Index1 vs f_index.01, Thumb2 vs thumb.02, etc.).
  const finger = findFingerDeformBone(rig,shortName);
  if (finger) return finger;

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

  // If a direct control exists but has zero vertex influence, returning it
  // would create a "successful" bake that never moves the visible mesh.
  // Mark it unresolved instead.
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

function rigExtent(restMap){
  if (!restMap || !restMap.size) return 1;
  const min = new THREE.Vector3(Infinity,Infinity,Infinity);
  const max = new THREE.Vector3(-Infinity,-Infinity,-Infinity);
  for (const r of restMap.values()){
    min.min(r.worldPosition);
    max.max(r.worldPosition);
  }
  const size = max.sub(min);
  return Math.max(size.x,size.y,size.z,EPS);
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
  const c = String(pair.channels || "ROT").toUpperCase();
  return c === "ROT" || c === "LOC_ROT";
}

function pairHasLocation(pair){
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

function actualPairRecords(pairs,sourceRig,targetRig,sourcePrefix,targetPrefix){
  const out = [];
  for (const raw of pairs || []){
    const sourceBone = resolveBone(sourceRig,raw.source,sourcePrefix);
    const targetBone = resolveRetargetTargetBone(targetRig,raw.target,targetPrefix);
    if (!sourceBone || !targetBone) continue;
    out.push({
      ...raw,
      sourceBone,
      targetBone,
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

  const locationScale = autoScale ? rigExtent(targetRig.rest) / rigExtent(sourceRest) : 1;
  const step = 1 / Math.max(1,Number(fps) || 30);
  const duration = Math.max(0,sourceClip.duration || 0);
  const frameCount = Math.max(2,Math.floor(duration / step + 0.5) + 1);
  const times = new Array(frameCount);
  for (let i=0;i<frameCount;i++) times[i] = Math.min(duration,i*step);
  times[frameCount-1] = duration;

  const targetByActual = new Map();
  for (const r of records){
    if (!targetByActual.has(r.targetBone.name)) targetByActual.set(r.targetBone.name,[]);
    targetByActual.get(r.targetBone.name).push(r);
  }

  const rotationTargets = new Set();
  const locationTargets = new Set();
  for (const r of records){
    if (pairHasRotation(r)) rotationTargets.add(r.targetBone.name);
    if (pairHasLocation(r)) locationTargets.add(r.targetBone.name);
  }

  const sortedBones = [...targetRig.bones].sort((a,b) =>
    targetRig.rest.get(a.name).depth - targetRig.rest.get(b.name).depth
  );

  const qValues = new Map();
  const pValues = new Map();
  const previousQ = new Map();
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

  for (let frame=0;frame<frameCount;frame++){
    const t = times[frame];
    setRigTime(sourceRig,t);

    localState.clear();
    worldOut.clear();

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

      // The first rotation row for a target owns its rotation.
      const rotRec = recs.find(pairHasRotation);
      let desiredWorldQ = null;
      if (rotRec){
        const srcRest = sourceRest.get(rotRec.sourceBone.name);
        const srcPoseQ = new THREE.Quaternion();
        rotRec.sourceBone.matrixWorld.decompose(new THREE.Vector3(),srcPoseQ,new THREE.Vector3());
        const motionScale = pairMotionScale(rotRec,faceSettings) * Number(rotRec.influence ?? 1);
        const deltaQ = quatScaledDelta(srcPoseQ,srcRest.worldQuaternion,motionScale);
        desiredWorldQ = deltaQ.multiply(rest.worldQuaternion.clone()).normalize();
      }

      const parentWorld = parentWorldForBone(bone,worldOut,rest);
      if (desiredWorldQ){
        const parentQ = new THREE.Quaternion();
        parentWorld.decompose(new THREE.Vector3(),parentQ,new THREE.Vector3());
        localQuat = parentQ.invert().multiply(desiredWorldQ).normalize();
      }

      localState.set(bone.name,{position:localPos,quaternion:localQuat,scale:localScale});
      worldOut.set(bone.name,buildWorldFromLocal(parentWorld,localPos,localQuat,localScale));
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

  const clip = new THREE.AnimationClip("Retargeted",duration,tracks);
  clip.resetDuration();
  resetRigToRest(targetRig);
  activateClip(targetRig,clip);
  setRigTime(targetRig,0);
  setRigTime(sourceRig,0);

  return {
    clip,
    validPairs:records.length,
    totalPairs:pairs.length,
    frameCount,
    locationScale,
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
      return out;
    })
  };
}
