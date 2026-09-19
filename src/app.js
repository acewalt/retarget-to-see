import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import {
  FACE_REGIONS,
  createRigState,
  resetRigToRest,
  activateClip,
  setRigTime,
  resolveBone,
  resolveRetargetTargetBone,
  countValidPairs,
  autoMatchPairs,
  stripKnownPrefix,
  guessPrefix,
  bakeRetarget,
  bakeIkIntoClip,
  previewRestPosePreset,
  captureRestPosePreset,
  serializeMap
} from "./retarget-engine.js";

const $ = id => document.getElementById(id);

const els = {
  sourceViewport:$("sourceViewport"),
  targetViewport:$("targetViewport"),
  sourceDropHint:$("sourceDropHint"),
  targetDropHint:$("targetDropHint"),
  sourceMeta:$("sourceMeta"),
  targetMeta:$("targetMeta"),
  sourceFile:$("sourceFile"),
  targetFile:$("targetFile"),
  sourceClipSelect:$("sourceClipSelect"),
  presetSelect:$("presetSelect"),
  presetFile:$("presetFile"),
  sourcePrefix:$("sourcePrefix"),
  targetPrefix:$("targetPrefix"),
  reloadPresetBtn:$("reloadPresetBtn"),
  savePresetBtn:$("savePresetBtn"),
  validCount:$("validCount"),
  mapSearch:$("mapSearch"),
  addPairBtn:$("addPairBtn"),
  addAllBtn:$("addAllBtn"),
  autoMatchBtn:$("autoMatchBtn"),
  sortBtn:$("sortBtn"),
  clearMapBtn:$("clearMapBtn"),
  copyBoneMapBtn:$("copyBoneMapBtn"),
  mappingRows:$("mappingRows"),
  sourceBoneList:$("sourceBoneList"),
  targetBoneList:$("targetBoneList"),
  autoScale:$("autoScale"),
  useCurrentRest:$("useCurrentRest"),
  useCustomRest:$("useCustomRest"),
  restPoseSelect:$("restPoseSelect"),
  restPoseFile:$("restPoseFile"),
  previewRestBtn:$("previewRestBtn"),
  saveRestBtn:$("saveRestBtn"),
  includeRestLocScale:$("includeRestLocScale"),
  autoBakeIk:$("autoBakeIk"),
  useWorldLocation:$("useWorldLocation"),
  headSource:$("headSource"),
  headTarget:$("headTarget"),
  facePerRegion:$("facePerRegion"),
  faceGlobal:$("faceGlobal"),
  faceRegions:$("faceRegions"),
  addIkChainBtn:$("addIkChainBtn"),
  ikRows:$("ikRows"),
  applyBtn:$("applyBtn"),
  convertIkBtn:$("convertIkBtn"),
  exportGlbBtn:$("exportGlbBtn"),
  exportClipBtn:$("exportClipBtn"),
  progressWrap:$("progressWrap"),
  progressBar:$("progressBar"),
  progressText:$("progressText"),
  status:$("status"),
  playBtn:$("playBtn"),
  timeline:$("timeline"),
  timeLabel:$("timeLabel"),
  fpsInput:$("fpsInput"),
  syncCameras:$("syncCameras"),
  frameSourceBtn:$("frameSourceBtn"),
  frameTargetBtn:$("frameTargetBtn")
};

const state = {
  sourceRig:null,
  targetRig:null,
  sourceClip:null,
  retargetClip:null,
  pairs:[],
  ikChains:[],
  preset:null,
  presetManifest:[],
  customPresets:[],
  restPoseManifest:[],
  customRestPoses:[],
  restPosePreset:null,
  restPoseBuiltin:false,
  currentTime:0,
  playing:false,
  lastTick:performance.now(),
  busy:false,
  faceRegions:Object.fromEntries(FACE_REGIONS.map(r => [r,1]))
};

class RigViewport{
  constructor(container){
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x101318);
    this.camera = new THREE.PerspectiveCamera(40,1,0.01,100000);
    this.camera.position.set(2.8,1.8,3.8);
    this.renderer = new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:"high-performance"});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1,2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera,this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .08;
    this.controls.target.set(0,1,0);

    const hemi = new THREE.HemisphereLight(0xffffff,0x28313b,2.5);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff,2.2);
    dir.position.set(3,5,4);
    this.scene.add(dir);

    this.grid = new THREE.GridHelper(20,40,0x3b4652,0x242a31);
    this.grid.material.transparent = true;
    this.grid.material.opacity = .45;
    this.scene.add(this.grid);

    this.root = null;
    this.helper = null;
    this.rig = null;

    // Camera-link reference values. Each viewport keeps its own framing
    // center/radius so the same orbit/zoom can be mirrored across rigs of
    // very different sizes without copying absolute world coordinates.
    this.frameCenter = this.controls.target.clone();
    this.frameRadius = 1;
    this.frameDistance = this.camera.position.distanceTo(this.controls.target);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }
  resize(){
    const w = Math.max(1,this.container.clientWidth);
    const h = Math.max(1,this.container.clientHeight);
    this.renderer.setSize(w,h,false);
    this.camera.aspect = w/h;
    this.camera.updateProjectionMatrix();
  }
  setRig(rig){
    if (this.root) this.scene.remove(this.root);
    if (this.helper) this.scene.remove(this.helper);
    this.rig = rig;
    this.root = rig?.root || null;
    if (this.root){
      this.scene.add(this.root);
      this.helper = new THREE.SkeletonHelper(this.root);
      this.helper.material.transparent = true;
      this.helper.material.opacity = .72;
      this.helper.material.depthTest = false;
      this.scene.add(this.helper);
      this.frame();
    }
  }
  frame(){
    if (!this.rig || !this.rig.bones.length) return;
    this.rig.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    let initialized = false;
    const p = new THREE.Vector3();
    for (const bone of this.rig.bones){
      p.setFromMatrixPosition(bone.matrixWorld);
      if (!initialized){
        box.min.copy(p);box.max.copy(p);initialized=true;
      } else box.expandByPoint(p);
    }
    // Include meshes when present.
    const objectBox = new THREE.Box3().setFromObject(this.rig.root);
    if (!objectBox.isEmpty()){
      box.union(objectBox);
      initialized = true;
    }
    if (!initialized) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length()*.5,.1);
    const distance = radius / Math.tan(THREE.MathUtils.degToRad(this.camera.fov*.5)) * 1.25;
    const direction = new THREE.Vector3(1,.45,1).normalize();

    this.frameCenter.copy(center);
    this.frameRadius = radius;
    this.frameDistance = distance;

    this.camera.position.copy(center).addScaledVector(direction,distance);
    this.camera.near = Math.max(.001,distance/1000);
    this.camera.far = Math.max(1000,distance*20);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.grid.position.y = box.min.y;
  }
  syncCameraTo(other){
    if (!other?.rig || !this.rig) return;

    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = Math.max(offset.length(),1e-6);
    const direction = offset.multiplyScalar(1/distance);

    // Keep zoom proportional to each rig's own fitted camera distance.
    const sourceBaseDistance = Math.max(this.frameDistance || distance,1e-6);
    const zoomRatio = distance/sourceBaseDistance;
    const targetBaseDistance = Math.max(other.frameDistance || distance,1e-6);

    // Mirror panning proportionally to each rig's framing radius instead of
    // copying an absolute translation (the characters can have very
    // different dimensions/origins).
    const sourceRadius = Math.max(this.frameRadius || 1,1e-6);
    const targetRadius = Math.max(other.frameRadius || 1,1e-6);
    const pan = this.controls.target.clone()
      .sub(this.frameCenter)
      .multiplyScalar(targetRadius/sourceRadius);

    other.controls.target.copy(other.frameCenter).add(pan);
    other.camera.position.copy(other.controls.target)
      .addScaledVector(direction,targetBaseDistance*zoomRatio);

    other.camera.near = Math.max(.001,(targetBaseDistance*zoomRatio)/1000);
    other.camera.far = Math.max(1000,targetBaseDistance*zoomRatio*20);
    other.camera.updateProjectionMatrix();
    other.controls.update();
  }
  render(){
    this.controls.update();
    if (this.helper) this.helper.updateMatrixWorld(true);
    this.renderer.render(this.scene,this.camera);
  }
}

const sourceView = new RigViewport(els.sourceViewport);
const targetView = new RigViewport(els.targetViewport);

let activeCameraSyncView = null;
let cameraSyncUpdating = false;

function syncViewportCamera(from,to){
  if (!els.syncCameras?.checked) return;
  if (cameraSyncUpdating) return;
  if (!from?.rig || !to?.rig) return;
  if (activeCameraSyncView && activeCameraSyncView !== from) return;

  cameraSyncUpdating = true;
  try{
    from.syncCameraTo(to);
  }finally{
    cameraSyncUpdating = false;
  }
}

function bindLinkedCameraControls(view,other){
  view.controls.addEventListener("start",() => {
    activeCameraSyncView = view;
  });
  view.controls.addEventListener("change",() => {
    syncViewportCamera(view,other);
  });
  view.controls.addEventListener("end",() => {
    // OrbitControls damping continues briefly after pointer-up. Keep this
    // viewport as the driver for a short interval to avoid camera ping-pong.
    const finishing = view;
    setTimeout(() => {
      if (activeCameraSyncView === finishing) activeCameraSyncView = null;
    },220);
  });
}

bindLinkedCameraControls(sourceView,targetView);
bindLinkedCameraControls(targetView,sourceView);

function setStatus(message,kind=""){
  els.status.textContent = message;
  els.status.className = "status" + (kind ? " " + kind : "");
}

function setProgress(value,text=""){
  const v = Math.max(0,Math.min(1,value || 0));
  els.progressWrap.hidden = false;
  els.progressBar.style.width = `${Math.round(v*100)}%`;
  els.progressText.textContent = `${Math.round(v*100)}%`;
  if (text) setStatus(text);
}

function hideProgress(){
  els.progressWrap.hidden = true;
  els.progressBar.style.width = "0%";
  els.progressText.textContent = "0%";
}

function downloadBlob(blob,fileName){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url),1500);
}

function safeBaseName(name="file"){
  return name.replace(/\.[^.]+$/,"").replace(/[^a-z0-9_\-]+/gi,"_") || "retargeted";
}

const originalMaterialByMesh = new WeakMap();
const solidMaterialByMesh = new WeakMap();

function makeSolidWhiteMaterial(){
  return new THREE.MeshStandardMaterial({
    color:0xffffff,
    roughness:1,
    metalness:0,
    side:THREE.DoubleSide
  });
}

function applySolidWhiteViewport(root){
  // Viewport-only override. WeakMaps keep Material objects out of userData,
  // so GLTFExporter never tries to serialize Three.js material instances.
  root.traverse(obj => {
    if (!obj.isMesh) return;

    if (!originalMaterialByMesh.has(obj)){
      originalMaterialByMesh.set(obj,obj.material);
    }

    if (!solidMaterialByMesh.has(obj)){
      solidMaterialByMesh.set(
        obj,
        Array.isArray(obj.material)
          ? obj.material.map(() => makeSolidWhiteMaterial())
          : makeSolidWhiteMaterial()
      );
    }

    obj.material = solidMaterialByMesh.get(obj);
  });
}

function restoreOriginalViewportMaterials(root){
  root.traverse(obj => {
    if (!obj.isMesh) return;
    if (originalMaterialByMesh.has(obj)){
      obj.material = originalMaterialByMesh.get(obj);
    }
  });
}

function compactBoneName(name=""){
  let n = String(name).toLowerCase();
  const colon = n.lastIndexOf(":");
  if (colon >= 0) n = n.slice(colon + 1);
  return n
    .replace(/^(def|org|mch|ctrl|control|bone)[._\- ]*/,"")
    .replace(/^c[._\- ]+/,"")
    .replace(/[^a-z0-9]/g,"");
}

function collectBones(root){
  const bones = [];
  root.traverse(obj => { if (obj.isBone) bones.push(obj); });
  return bones;
}

function scoreNamedBone(bone,kind){
  const n = compactBoneName(bone.name);
  if (!n) return -Infinity;

  if (kind === "HEAD"){
    if (n === "head") return 1000;
    if (n.endsWith("head")) return 900;
    if (n.includes("head") && !n.includes("tweak")) return 700;
    if (n === "neck") return 200;
    return -Infinity;
  }

  if (kind === "HIPS"){
    if (n === "hips" || n === "pelvis") return 1000;
    if (n.endsWith("hips") || n.endsWith("pelvis")) return 900;
    if (n.includes("hips") || n.includes("pelvis")) return 750;
    if (n === "spine") return 250;
    if (n.startsWith("spine")) return 150;
    return -Infinity;
  }

  return -Infinity;
}

function findOrientationBone(root,kind){
  const bones = collectBones(root);
  let best = null;
  let bestScore = -Infinity;
  for (const bone of bones){
    let score = scoreNamedBone(bone,kind);
    if (!Number.isFinite(score)) continue;

    // Prefer deform/FK-ish bones over mechanism/tweak controls when names tie.
    const raw = bone.name.toLowerCase();
    if (raw.includes("mch")) score -= 80;
    if (raw.includes("tweak")) score -= 80;
    if (raw.includes("org")) score -= 20;

    if (score > bestScore){
      best = bone;
      bestScore = score;
    }
  }
  return best;
}

function normalizeTargetUpright(root){
  // FBX can contain an armature/object transform that leaves the complete
  // receiver lying on X/Z even though its bind pose is otherwise correct.
  // Fix that transform BEFORE createRigState() snapshots the target rest.
  root.updateMatrixWorld(true);

  const hips = findOrientationBone(root,"HIPS");
  const head = findOrientationBone(root,"HEAD");
  if (!hips || !head){
    return {
      corrected:false,
      reason:"No pude identificar Head/Hips para detectar orientación."
    };
  }

  const hipsPos = new THREE.Vector3().setFromMatrixPosition(hips.matrixWorld);
  const headPos = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
  const bodyUp = headPos.clone().sub(hipsPos);
  if (bodyUp.lengthSq() < 1e-10){
    return {
      corrected:false,
      reason:"Head y Hips no definen un eje corporal válido."
    };
  }

  bodyUp.normalize();
  const worldUp = new THREE.Vector3(0,1,0);
  const alignment = bodyUp.dot(worldUp);

  // Already upright (or almost upright). Do not introduce a gratuitous
  // correction on FBXs that were imported correctly.
  if (alignment >= 0.82){
    return {
      corrected:false,
      alignment,
      head:head.name,
      hips:hips.name,
      reason:"El Target ya está vertical."
    };
  }

  // If the character is upside-down this also resolves the 180° case.
  const correction = new THREE.Quaternion().setFromUnitVectors(bodyUp,worldUp);
  root.quaternion.premultiply(correction).normalize();
  root.updateMatrix();
  root.updateMatrixWorld(true);

  const newHips = new THREE.Vector3().setFromMatrixPosition(hips.matrixWorld);
  const newHead = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
  const newAlignment = newHead.sub(newHips).normalize().dot(worldUp);

  return {
    corrected:true,
    alignment,
    newAlignment,
    angleDegrees:THREE.MathUtils.radToDeg(2 * Math.acos(
      THREE.MathUtils.clamp(Math.abs(correction.w),0,1)
    )),
    head:head.name,
    hips:hips.name
  };
}

function forceTargetBindPose(root){
  // The Target is a receiver, never an animation source. FBX files can
  // contain Actions/Takes and can also be exported while a pose is active.
  // Reconstruct the bind pose from each SkinnedMesh's inverse bind matrices
  // before we snapshot the Target rest transforms.
  const skeletons = new Set();
  let skinnedMeshes = 0;

  root.updateMatrixWorld(true);
  root.traverse(obj => {
    if (!obj.isSkinnedMesh || !obj.skeleton) return;
    skinnedMeshes++;
    if (skeletons.has(obj.skeleton)) return;
    obj.skeleton.pose();
    skeletons.add(obj.skeleton);
  });
  root.updateMatrixWorld(true);

  return {
    skeletonCount:skeletons.size,
    skinnedMeshes
  };
}

async function loadFbx(file,kind){
  if (!file) return;
  setStatus(`Cargando ${kind}: ${file.name}…`);
  const buffer = await file.arrayBuffer();
  const loader = new FBXLoader();
  let root;
  try{
    root = loader.parse(buffer,"");
  }catch(err){
    console.error(err);
    throw new Error(`No pude leer ${file.name} como FBX: ${err.message || err}`);
  }
  root.name ||= safeBaseName(file.name);

  // Source keeps its embedded clips because those are the motion to read.
  // Target clips are deliberately ignored: Target must enter the pipeline
  // as a static rig in bind/rest pose and only receive the baked Source clip.
  let ignoredTargetClips = 0;
  let targetBindInfo = null;
  let targetOrientationInfo = null;
  if (kind === "Target"){
    ignoredTargetClips = Array.isArray(root.animations) ? root.animations.length : 0;

    // Order matters:
    //   bind pose -> upright normalization -> rest snapshot
    targetBindInfo = forceTargetBindPose(root);
    root.animations = [];
    targetOrientationInfo = normalizeTargetUpright(root);
  }

  // Retargeting view is intentionally material-agnostic. Both rigs are shown
  // as neutral white solids while the original FBX materials remain cached.
  applySolidWhiteViewport(root);

  root.updateMatrixWorld(true);
  const rig = createRigState(root,file.name);
  if (!rig.bones.length) throw new Error(`${file.name} no contiene huesos FBX detectables.`);

  if (kind === "Source"){
    state.sourceRig = rig;
    state.sourceClip = rig.animations[0] || null;
    sourceView.setRig(rig);
    els.sourceDropHint.hidden = true;
    populateSourceClips();
    if (state.sourceClip) activateClip(rig,state.sourceClip);
    els.sourceMeta.textContent = `${file.name} · ${rig.bones.length} huesos · ${rig.animations.length} clips`;
  } else {
    state.targetRig = rig;
    state.retargetClip = null;

    // Explicitly stop/clear any mixer state and keep Target at the rest pose
    // captured *after* skeleton.pose(). No imported Target Action is allowed
    // to participate in preview or retargeting.
    resetRigToRest(rig);

    targetView.setRig(rig);
    els.targetDropHint.hidden = true;
    const ignored = ignoredTargetClips
      ? ` · ${ignoredTargetClips} clips ignorados`
      : "";
    const weightedInfo = rig.weightedBoneNames?.size
      ? ` · ${rig.weightedBoneNames.size} deform reales`
      : "";
    els.targetMeta.textContent = `${file.name} · ${rig.bones.length} huesos${weightedInfo}${ignored}`;
    els.exportGlbBtn.disabled = true;
    els.exportClipBtn.disabled = true;
    els.convertIkBtn.disabled = true;

    const bindDetail = targetBindInfo?.skeletonCount
      ? ` Bind pose restaurado desde ${targetBindInfo.skeletonCount} skeleton(s).`
      : " No se encontró un SkinnedMesh con bind pose; se usa la pose estática importada.";
    const orientationDetail = targetOrientationInfo?.corrected
      ? ` Orientación corregida automáticamente (${targetOrientationInfo.angleDegrees.toFixed(1)}°) usando ${targetOrientationInfo.hips} → ${targetOrientationInfo.head}.`
      : ` ${targetOrientationInfo?.reason || "Orientación sin cambios."}`;
    setStatus(
      `Target cargado en pose neutral. ${ignoredTargetClips} Action/clip(s) del Target ignorados.${bindDetail}${orientationDetail} Viewport: blanco sólido.`,
      "success"
    );
  }

  populateBoneLists();
  maybeAutodetectPrefixes();
  updateValidCount();
  updateTransport();
  updateButtons();

  // If the other rig was already loaded/orbited, bring the newly loaded
  // viewport immediately to the same camera orientation.
  if (els.syncCameras?.checked && state.sourceRig && state.targetRig){
    if (kind === "Target") syncViewportCamera(sourceView,targetView);
    else syncViewportCamera(targetView,sourceView);
  }

  if (kind === "Source"){
    setStatus(`Source cargado: ${file.name}.`,"success");
  }
}

function populateSourceClips(){
  const select = els.sourceClipSelect;
  select.innerHTML = "";
  if (!state.sourceRig?.animations.length){
    select.disabled = true;
    const o = new Option("El FBX no contiene animaciones","");
    select.add(o);
    state.sourceClip = null;
    return;
  }
  state.sourceRig.animations.forEach((clip,i) => {
    select.add(new Option(`${clip.name || "Clip " + (i+1)} · ${clip.duration.toFixed(2)} s`,String(i)));
  });
  const index = Math.max(0,state.sourceRig.animations.indexOf(state.sourceClip));
  select.value = String(index);
  select.disabled = false;
}

function populateBoneLists(){
  els.sourceBoneList.innerHTML = "";
  els.targetBoneList.innerHTML = "";
  for (const name of state.sourceRig?.boneNames || []){
    els.sourceBoneList.appendChild(new Option(name));
  }
  for (const name of state.targetRig?.boneNames || []){
    els.targetBoneList.appendChild(new Option(name));
  }
}

function currentPrefixes(){
  return {
    sourcePrefix:els.sourcePrefix.value || "",
    targetPrefix:els.targetPrefix.value || ""
  };
}

function maybeAutodetectPrefixes(){
  if (!state.pairs.length) return;
  const sourceNames = state.pairs.map(p => p.source).filter(Boolean);
  const targetNames = state.pairs.map(p => p.target).filter(Boolean);

  if (state.sourceRig && (!els.sourcePrefix.value || !sourceNames.some(n => state.sourceRig.boneMap.has(els.sourcePrefix.value+n)))){
    const guessed = guessPrefix(sourceNames,state.sourceRig.boneNames);
    if (guessed) els.sourcePrefix.value = guessed;
  }
  if (state.targetRig && (!els.targetPrefix.value || !targetNames.some(n => state.targetRig.boneMap.has(els.targetPrefix.value+n)))){
    const guessed = guessPrefix(targetNames,state.targetRig.boneNames);
    if (guessed) els.targetPrefix.value = guessed;
  }
}

function remapBlenderAxesToThree(mask="XYZ"){
  const src = String(mask || "XYZ").toUpperCase();
  const out = new Set();
  if (src.includes("X")) out.add("X");
  if (src.includes("Y")) out.add("Z"); // Blender forward -> Three depth
  if (src.includes("Z")) out.add("Y"); // Blender up -> Three up
  return ["X","Y","Z"].filter(a => out.has(a)).join("") || "XYZ";
}

function normalizePair(raw={},axisConvention="THREE_Y_UP"){
  const setAsRoot = Boolean(raw.set_as_root);
  const channels = setAsRoot
    ? "LOC_ROT"
    : String(raw.channels || "ROT").toUpperCase();
  return {
    source:String(raw.source || ""),
    target:String(raw.target || ""),
    channels:["ROT","LOC","LOC_ROT"].includes(channels) ? channels : "ROT",
    axes:axisConvention === "BLENDER_Z_UP"
      ? remapBlenderAxesToThree(raw.axes || "XYZ")
      : String(raw.axes || "XYZ").toUpperCase(),
    loc_space:String(raw.loc_space || "BASIS").toUpperCase() === "HEAD_LOCAL" ? "HEAD_LOCAL" : "BASIS",
    influence:Number.isFinite(Number(raw.influence)) ? Number(raw.influence) : 1,
    loc_scale:Number.isFinite(Number(raw.loc_scale)) ? Number(raw.loc_scale) : 1,
    loc_scale_residual:Boolean(raw.loc_scale_residual),
    set_as_root:setAsRoot
  };
}

function updateValidCount(){
  const {sourcePrefix,targetPrefix} = currentPrefixes();
  const result = countValidPairs(state.pairs,state.sourceRig,state.targetRig,sourcePrefix,targetPrefix);
  const detail = detailedMappingCoverage();
  const redirected = detail.redirected
    ? ` · ${detail.redirected} → deform`
    : "";
  const fingerText = detail.fingerTotal
    ? ` · cuerpo ${detail.coreValid}/${detail.coreTotal} · dedos ${detail.fingerValid}/${detail.fingerTotal}`
    : "";
  els.validCount.textContent = `${detail.valid} / ${detail.total} válidos${fingerText}${redirected}`;
  // Missing fingers are optional: only flag as bad when a non-finger/core
  // pair is unresolved.
  els.validCount.classList.toggle("bad",detail.coreTotal > 0 && detail.coreValid < detail.coreTotal);
  updateButtons();
}

function makeBoneInput(value,listId,onChange){
  const input = document.createElement("input");
  input.type = "text";
  input.value = value || "";
  input.setAttribute("list",listId);
  input.spellcheck = false;
  input.addEventListener("change",() => onChange(input.value));
  input.addEventListener("input",() => onChange(input.value,false));
  return input;
}

function renderMappings(){
  const filter = els.mapSearch.value.trim().toLowerCase();
  els.mappingRows.innerHTML = "";

  const {sourcePrefix,targetPrefix} = currentPrefixes();
  let visible = 0;
  state.pairs.forEach((pair,index) => {
    if (filter && !pair.source.toLowerCase().includes(filter) && !pair.target.toLowerCase().includes(filter)) return;
    visible++;

    const sourceResolved = resolveBone(state.sourceRig,pair.source,sourcePrefix);
    const directTarget = resolveBone(state.targetRig,pair.target,targetPrefix);
    const targetResolved = resolveRetargetTargetBone(
      state.targetRig,
      pair.target,
      targetPrefix
    );
    const valid = Boolean(sourceResolved && targetResolved);

    const row = document.createElement("div");
    const optionalFingerMissing = !valid && isFingerPair(pair);
    row.className = "map-row"
      + (valid ? "" : optionalFingerMissing ? " optional-missing" : " invalid");

    const sourceInput = makeBoneInput(pair.source,"sourceBoneList",(v,commit=true) => {
      pair.source = v;
      updateValidCount();
      if (commit) renderMappings();
    });
    if (sourceResolved) sourceInput.title = `Source real: ${sourceResolved.name}`;
    row.appendChild(sourceInput);

    const targetInput = makeBoneInput(pair.target,"targetBoneList",(v,commit=true) => {
      pair.target = v;
      updateValidCount();
      if (commit) renderMappings();
    });
    if (targetResolved){
      targetInput.title = directTarget && targetResolved !== directTarget
        ? `Control FBX sin constraints → animando deform bone: ${targetResolved.name}`
        : `Target real: ${targetResolved.name}`;
    } else if (isFingerPair(pair)){
      targetInput.title = "Dedo opcional no encontrado en los deform bones del Target; no bloquea el retarget corporal.";
    }
    row.appendChild(targetInput);

    const channels = document.createElement("select");
    for (const [value,label] of [["ROT","Rotation"],["LOC","Location"],["LOC_ROT","Loc + Rot"]]){
      channels.add(new Option(label,value));
    }
    channels.value = pair.channels;
    channels.addEventListener("change",() => {
      pair.channels = channels.value;
      renderMappings();
      updateValidCount();
    });
    row.appendChild(channels);

    const anchor = document.createElement("label");
    anchor.className = "anchor";
    const anchorInput = document.createElement("input");
    anchorInput.type = "checkbox";
    anchorInput.checked = pair.loc_space === "HEAD_LOCAL";
    anchorInput.disabled = pair.channels === "ROT";
    anchorInput.title = "Head-local / Anchor";
    anchorInput.addEventListener("change",() => {
      pair.loc_space = anchorInput.checked ? "HEAD_LOCAL" : "BASIS";
    });
    anchor.appendChild(anchorInput);
    row.appendChild(anchor);

    const remove = document.createElement("button");
    remove.className = "remove-btn";
    remove.textContent = "×";
    remove.title = "Eliminar par";
    remove.addEventListener("click",() => {
      state.pairs.splice(index,1);
      renderMappings();
      updateValidCount();
    });
    row.appendChild(remove);

    if (pair.channels !== "ROT"){
      const advanced = document.createElement("div");
      advanced.className = "axes-row";
      const axesLabel = document.createElement("span");
      axesLabel.textContent = "Axes";
      const axes = document.createElement("select");
      ["XYZ","XY","XZ","YZ","X","Y","Z"].forEach(a => axes.add(new Option(a,a)));
      axes.value = pair.axes || "XYZ";
      axes.addEventListener("change",() => pair.axes = axes.value);

      const scaleLabel = document.createElement("span");
      scaleLabel.textContent = "Scale";
      const scale = document.createElement("input");
      scale.type = "number";
      scale.step = "0.05";
      scale.value = String(pair.loc_scale ?? 1);
      scale.title = "Amplificación por par";
      scale.addEventListener("change",() => pair.loc_scale = Number(scale.value) || 0);

      const rootLabel = document.createElement("label");
      rootLabel.className = "mini-check";
      rootLabel.title = "Set as Root: transfiere Translation + Rotation como en Auto-Rig Pro.";
      const rootInput = document.createElement("input");
      rootInput.type = "checkbox";
      rootInput.checked = Boolean(pair.set_as_root);
      rootInput.addEventListener("change",() => {
        pair.set_as_root = rootInput.checked;
        if (pair.set_as_root) pair.channels = "LOC_ROT";
        renderMappings();
        updateValidCount();
      });
      const rootText = document.createElement("span");
      rootText.textContent = "Root";
      rootLabel.append(rootInput,rootText);

      advanced.append(axesLabel,axes,scaleLabel,scale,rootLabel);
      row.appendChild(advanced);
    }

    els.mappingRows.appendChild(row);
  });

  if (!visible){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.pairs.length ? "Ningún par coincide con la búsqueda." : "Bone map vacío.";
    els.mappingRows.appendChild(empty);
  }
}

function addAllSourceBones(){
  if (!state.sourceRig) return;
  const prefix = els.sourcePrefix.value || "";
  state.pairs = state.sourceRig.bones.map(b => normalizePair({
    source:stripKnownPrefix(b.name,prefix),
    target:"",
    channels:"ROT"
  }));
  renderMappings();
  updateValidCount();
}

function autoMatch(){
  if (!state.sourceRig || !state.targetRig) return;
  const {sourcePrefix,targetPrefix} = currentPrefixes();
  const matched = autoMatchPairs(state.sourceRig,state.targetRig,sourcePrefix,targetPrefix);
  if (!matched.length){
    setStatus("Auto-Match no encontró nombres equivalentes.","error");
    return;
  }
  state.pairs = matched.map(normalizePair);
  renderMappings();
  updateValidCount();
  setStatus(`Auto-Match creó ${matched.length} pares.`,"success");
}

function renderFaceRegions(){
  els.faceRegions.innerHTML = "";
  for (const region of FACE_REGIONS){
    const wrap = document.createElement("div");
    wrap.className = "face-region";
    const label = document.createElement("label");
    label.textContent = region;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "-4";
    input.max = "4";
    input.step = "0.05";
    input.value = String(state.faceRegions[region] ?? 1);
    input.disabled = !els.facePerRegion.checked;
    input.addEventListener("change",() => {
      state.faceRegions[region] = Number(input.value);
    });
    wrap.append(label,input);
    els.faceRegions.appendChild(wrap);
  }
}

function normalizeIkChain(c={}){
  return {
    limb_kind:String(c.limb_kind || c.kind || "ARM").toUpperCase().includes("LEG") ? "LEG" : "ARM",
    side:String(c.side || "L").toUpperCase().startsWith("R") ? "R" : "L",
    owner:String(c.owner || ""),
    ik_control:String(c.ik_control || ""),
    pole_control:String(c.pole_control || "")
  };
}

function renderIkRows(){
  els.ikRows.innerHTML = "";
  if (!state.ikChains.length){
    els.ikRows.innerHTML = '<div class="empty-state">El preset puede llenar estas cadenas.</div>';
    return;
  }
  state.ikChains.forEach((chain,index) => {
    const row = document.createElement("div");
    row.className = "ik-row";

    const top = document.createElement("div");
    top.className = "ik-row-top";
    const kind = document.createElement("select");
    kind.add(new Option("Arm","ARM"));
    kind.add(new Option("Leg","LEG"));
    kind.value = chain.limb_kind;
    kind.addEventListener("change",() => chain.limb_kind = kind.value);
    const side = document.createElement("select");
    side.add(new Option("L","L"));side.add(new Option("R","R"));
    side.value = chain.side;
    side.addEventListener("change",() => chain.side = side.value);
    const owner = makeBoneInput(chain.owner,"targetBoneList",v => chain.owner = v);
    owner.placeholder = "IK owner (opcional)";
    const remove = document.createElement("button");
    remove.className = "remove-btn";
    remove.textContent = "×";
    remove.addEventListener("click",() => {
      state.ikChains.splice(index,1);
      renderIkRows();
    });
    top.append(kind,side,owner,remove);

    const bottom = document.createElement("div");
    bottom.className = "ik-row-bottom";
    const control = makeBoneInput(chain.ik_control,"targetBoneList",v => chain.ik_control = v);
    control.placeholder = "IK control";
    const pole = makeBoneInput(chain.pole_control,"targetBoneList",v => chain.pole_control = v);
    pole.placeholder = "Pole control";
    bottom.append(control,pole);

    row.append(top,bottom);
    els.ikRows.appendChild(row);
  });
}

function faceSettings(){
  return {
    global:Number(els.faceGlobal.value || 1),
    perRegion:els.facePerRegion.checked,
    regions:{...state.faceRegions}
  };
}

function isLikelyMixamoSource(){
  if (state.preset?.name?.toLowerCase().startsWith("mixamo")) return true;
  if ((els.sourcePrefix.value || "").toLowerCase().includes("mixamorig")) return true;
  return Boolean(state.sourceRig?.boneNames?.some(name =>
    String(name).toLowerCase().includes("mixamorig")
  ));
}

function builtInRestPoseCompatible(){
  // BlendCap's bundled T/A pose files encode pose deltas captured from the
  // BlendCap source armature. A Mixamo FBX already carries its own bind/rest
  // pose; applying those bundled source overrides to Mixamo can rotate the
  // whole source incorrectly. User-saved/imported web rest poses remain valid.
  if (!state.restPoseBuiltin) return true;
  if (!state.restPosePreset) return true;
  if (!isLikelyMixamoSource()) return true;
  const n = String(state.restPosePreset.name || "").toUpperCase();
  return !(n === "T-POSE" || n === "A-POSE");
}

function mappingCoverage(){
  const {sourcePrefix,targetPrefix} = currentPrefixes();
  return countValidPairs(
    state.pairs,
    state.sourceRig,
    state.targetRig,
    sourcePrefix,
    targetPrefix
  );
}

function isFingerPair(pair){
  const text = `${pair?.source || ""} ${pair?.target || ""}`.toLowerCase();
  return /(finger|thumb|index|middle|ring|pinky|little)/.test(text);
}

function resolveIkDiagnostic(chain){
  const prefix = els.targetPrefix.value || "";
  return {
    limb_kind:chain.limb_kind,
    side:chain.side,
    ownerRequested:chain.owner || "",
    ownerResolved:resolveBone(state.targetRig,chain.owner || "",prefix)?.name || null,
    controlRequested:chain.ik_control || "",
    controlResolved:resolveBone(state.targetRig,chain.ik_control || "",prefix)?.name || null,
    poleRequested:chain.pole_control || "",
    poleResolved:resolveBone(state.targetRig,chain.pole_control || "",prefix)?.name || null
  };
}

function buildBoneMapDiagnostic(){
  const {sourcePrefix,targetPrefix} = currentPrefixes();
  const coverage = detailedMappingCoverage();

  const pairs = state.pairs.map((pair,index) => {
    const sourceResolved = resolveBone(state.sourceRig,pair.source,sourcePrefix);
    const directTarget = resolveBone(state.targetRig,pair.target,targetPrefix);
    const targetResolved = resolveRetargetTargetBone(
      state.targetRig,
      pair.target,
      targetPrefix
    );

    return {
      index:index + 1,
      sourceRequested:pair.source,
      sourceResolved:sourceResolved?.name || null,
      targetRequested:pair.target,
      targetDirect:directTarget?.name || null,
      targetResolved:targetResolved?.name || null,
      valid:Boolean(sourceResolved && targetResolved),
      redirected:Boolean(directTarget && targetResolved && directTarget !== targetResolved),
      targetWeighted:Boolean(
        targetResolved
        && state.targetRig?.weightedBoneNames?.has(targetResolved.name)
      ),
      targetHierarchyDriver:Boolean(
        targetResolved
        && state.targetRig?.hierarchyDriverBoneNames?.has(targetResolved.name)
      ),
      optionalFinger:isFingerPair(pair),
      channels:pair.channels,
      axes:pair.axes,
      loc_space:pair.loc_space,
      influence:pair.influence,
      loc_scale:pair.loc_scale,
      set_as_root:Boolean(pair.set_as_root)
    };
  });

  return {
    tool:"Retarget to See — Bone Map Diagnostic",
    generatedAt:new Date().toISOString(),
    source:{
      file:state.sourceRig?.fileName || null,
      clip:state.sourceClip?.name || null,
      clipDuration:state.sourceClip?.duration ?? null,
      prefix:sourcePrefix,
      boneCount:state.sourceRig?.bones?.length || 0,
      bones:state.sourceRig?.boneNames || []
    },
    target:{
      file:state.targetRig?.fileName || null,
      prefix:targetPrefix,
      boneCount:state.targetRig?.bones?.length || 0,
      skinBoneCount:state.targetRig?.skinBoneNames?.size || 0,
      weightedBoneCount:state.targetRig?.weightedBoneNames?.size || 0,
      hierarchyDriverBoneCount:state.targetRig?.hierarchyDriverBoneNames?.size || 0,
      hierarchyDriverBones:[...(state.targetRig?.hierarchyDriverBoneNames || [])].sort(),
      weightedBones:[...(state.targetRig?.weightedBoneNames || [])].sort(),
      skinBones:[...(state.targetRig?.skinBoneNames || [])].sort(),
      bones:state.targetRig?.boneNames || []
    },
    preset:{
      name:state.preset?.name || null,
      target_kind:state.preset?.target_kind || null,
      axis_convention:state.preset?.axis_convention || "BLENDER_Z_UP(default)",
      auto_bake_ik:Boolean(els.autoBakeIk.checked),
      auto_scale:Boolean(els.autoScale.checked),
      use_world_location:Boolean(els.useWorldLocation.checked),
      use_current_source_pose_as_rest:Boolean(els.useCurrentRest.checked),
      use_custom_rest_pose:Boolean(els.useCustomRest.checked),
      custom_rest_pose_name:state.restPosePreset?.name || null,
      include_rest_location_scale:Boolean(els.includeRestLocScale.checked)
    },
    coverage,
    pairs,
    ikChains:state.ikChains.map(resolveIkDiagnostic)
  };
}

async function writeClipboardText(textValue){
  if (navigator.clipboard?.writeText){
    try{
      await navigator.clipboard.writeText(textValue);
      return true;
    }catch(err){
      console.warn("Clipboard API failed, using fallback",err);
    }
  }

  const area = document.createElement("textarea");
  area.value = textValue;
  area.setAttribute("readonly","");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0,area.value.length);
  let ok = false;
  try{
    ok = document.execCommand("copy");
  }catch{
    ok = false;
  }
  area.remove();
  return ok;
}

async function copyBoneMapDiagnostic(){
  const diagnostic = buildBoneMapDiagnostic();
  const textValue = JSON.stringify(diagnostic,null,2);
  const ok = await writeClipboardText(textValue);

  if (ok){
    const old = els.copyBoneMapBtn.textContent;
    els.copyBoneMapBtn.textContent = "Copiado ✓";
    setStatus(
      `Diagnóstico copiado: ${diagnostic.coverage.valid}/${diagnostic.coverage.total} mappings válidos, ${diagnostic.target.weightedBoneCount} deform bones reales. Pégalo en el chat para revisar el mapeo exacto.`,
      "success"
    );
    setTimeout(() => {
      els.copyBoneMapBtn.textContent = old;
    },1600);
  }else{
    setStatus(
      "El navegador bloqueó el portapapeles. Prueba de nuevo después de hacer clic dentro de la página.",
      "error"
    );
  }
}

function detailedMappingCoverage(){
  const {sourcePrefix,targetPrefix} = currentPrefixes();
  let valid = 0;
  let redirected = 0;
  let coreTotal = 0;
  let coreValid = 0;
  let fingerTotal = 0;
  let fingerValid = 0;

  for (const pair of state.pairs){
    const source = resolveBone(state.sourceRig,pair.source,sourcePrefix);
    const directTarget = resolveBone(state.targetRig,pair.target,targetPrefix);
    const target = resolveRetargetTargetBone(state.targetRig,pair.target,targetPrefix);
    const ok = Boolean(source && target);
    const finger = isFingerPair(pair);

    if (finger){
      fingerTotal++;
      if (ok) fingerValid++;
    } else {
      coreTotal++;
      if (ok) coreValid++;
    }

    if (ok){
      valid++;
      if (directTarget && target !== directTarget) redirected++;
    }
  }

  const unresolvedCore = state.pairs
    .filter(pair => !isFingerPair(pair))
    .filter(pair => {
      const source = resolveBone(state.sourceRig,pair.source,sourcePrefix);
      const target = resolveRetargetTargetBone(state.targetRig,pair.target,targetPrefix);
      return !(source && target);
    })
    .map(pair => `${pair.source} → ${pair.target}`);

  return {
    valid,
    total:state.pairs.length,
    redirected,
    coreTotal,
    coreValid,
    fingerTotal,
    fingerValid,
    unresolvedCore
  };
}

function parseAutoRigProBmap(text,name="Auto-Rig Pro .bmap"){
  const blocks = String(text || "")
    .replace(/\r/g,"")
    .trim()
    .split(/\n\s*\n/)
    .map(b => b.split("\n").map(x => x.trim()).filter(Boolean))
    .filter(b => b.length >= 2);

  if (!blocks.length) throw new Error("El archivo .bmap está vacío o no tiene el formato esperado.");

  const pairs = [];
  const sourcePrefixes = new Map();

  for (const block of blocks){
    const targetLine = block[0] || "";
    const sourceFull = block[1] || "";
    if (!targetLine || !sourceFull) continue;

    const target = targetLine.split("%")[0].trim();
    let source = sourceFull.trim();

    const colon = source.lastIndexOf(":");
    if (colon >= 0){
      const pref = source.slice(0,colon+1);
      sourcePrefixes.set(pref,(sourcePrefixes.get(pref) || 0) + 1);
      source = source.slice(colon+1);
    }

    const setAsRoot = String(block[2] || "").toLowerCase() === "true";
    const locationLocal = String(block[3] || "").toLowerCase() === "true";

    pairs.push({
      source,
      target,
      channels:setAsRoot || locationLocal ? "LOC_ROT" : "ROT",
      axes:"XYZ",
      loc_space:"BASIS",
      influence:1,
      set_as_root:setAsRoot
    });
  }

  if (!pairs.length) throw new Error("No encontré pares Source → Target dentro del .bmap.");

  let sourcePrefix = "";
  let best = -1;
  for (const [pref,count] of sourcePrefixes){
    if (count > best){
      sourcePrefix = pref;
      best = count;
    }
  }

  return {
    name:name.replace(/\.bmap$/i,""),
    version:1,
    axis_convention:"THREE_Y_UP",
    source_prefix:sourcePrefix,
    namespace_strip:"",
    auto_bake_ik:false,
    use_world_location:true,
    imported_from:"Auto-Rig Pro .bmap",
    pairs
  };
}

function applyPresetData(data,sourceLabel="Preset"){
  state.preset = data;
  const axisConvention = data.axis_convention || "BLENDER_Z_UP";
  state.pairs = (data.pairs || []).map(p => normalizePair(p,axisConvention));
  state.ikChains = (data.ik_chains || []).map(normalizeIkChain);

  els.sourcePrefix.value = data.source_prefix || "";
  els.targetPrefix.value = data.namespace_strip || "";
  els.autoBakeIk.checked = Boolean(data.auto_bake_ik);
  els.useWorldLocation.checked = Boolean(data.use_world_location);
  els.headSource.value = data.face_head_source || "";
  els.headTarget.value = data.face_head_target || "";

  const amp = data.face_amplification || {};
  els.faceGlobal.value = String(Number(amp.global ?? 1));
  for (const region of FACE_REGIONS){
    state.faceRegions[region] = Number(amp[region] ?? 1);
  }
  els.facePerRegion.checked = Boolean(data.face_capture_compensation)
    || FACE_REGIONS.some(r => Math.abs((state.faceRegions[r] ?? 1)-1) > 1e-6);

  maybeAutodetectPrefixes();
  renderMappings();
  renderIkRows();
  renderFaceRegions();
  updateValidCount();

  if (els.useCustomRest.checked && !builtInRestPoseCompatible()){
    els.useCustomRest.checked = false;
    updateRestPoseControls();
  }

  const coverage = mappingCoverage();
  const coverageText = state.sourceRig && state.targetRig && coverage.total
    ? ` · ${coverage.valid}/${coverage.total} pares resueltos`
    : "";
  setStatus(`${sourceLabel}: ${data.name || "mapa cargado"}${coverageText}.`,"success");
}

async function loadPresetManifest(){
  try{
    const res = await fetch("./presets/index.json",{cache:"no-store"});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.presetManifest = data.presets || [];
  }catch(err){
    console.warn("Preset manifest",err);
    state.presetManifest = [];
    setStatus("La app abrió, pero no pude leer presets/index.json. El retarget manual sigue disponible.","error");
  }
  loadCustomPresets();
  renderPresetSelect();
}

function loadCustomPresets(){
  try{
    const raw = localStorage.getItem("retarget-to-see.customPresets");
    state.customPresets = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(state.customPresets)) state.customPresets = [];
  }catch{
    state.customPresets = [];
  }
}

function persistCustomPresets(){
  localStorage.setItem("retarget-to-see.customPresets",JSON.stringify(state.customPresets));
}

function loadCustomRestPoses(){
  try{
    const raw = localStorage.getItem("retarget-to-see.customRestPoses");
    state.customRestPoses = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(state.customRestPoses)) state.customRestPoses = [];
  }catch{
    state.customRestPoses = [];
  }
}

function persistCustomRestPoses(){
  localStorage.setItem("retarget-to-see.customRestPoses",JSON.stringify(state.customRestPoses));
}

async function loadRestPoseManifest(){
  try{
    const res = await fetch("./rest_pose_presets/index.json",{cache:"no-store"});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.restPoseManifest = data.presets || [];
  }catch(err){
    console.warn("Rest pose manifest",err);
    state.restPoseManifest = [];
  }
  loadCustomRestPoses();
  renderRestPoseSelect();
}

function renderRestPoseSelect(){
  const current = els.restPoseSelect.value;
  els.restPoseSelect.innerHTML = '<option value="">— Sin preset —</option>';

  if (state.restPoseManifest.length){
    const standard = document.createElement("optgroup");
    standard.label = "Standard Rest Poses";
    state.restPoseManifest.forEach(p =>
      standard.appendChild(new Option(p.name,`builtin:${p.file}`))
    );
    els.restPoseSelect.appendChild(standard);
  }
  if (state.customRestPoses.length){
    const custom = document.createElement("optgroup");
    custom.label = "Custom Rest Poses";
    state.customRestPoses.forEach((p,i) =>
      custom.appendChild(new Option(p.name || `Pose ${i+1}`,`custom:${i}`))
    );
    els.restPoseSelect.appendChild(custom);
  }
  els.restPoseSelect.disabled = !(state.restPoseManifest.length || state.customRestPoses.length);
  if ([...els.restPoseSelect.options].some(o => o.value === current)){
    els.restPoseSelect.value = current;
  }
}

async function loadSelectedRestPose(){
  const value = els.restPoseSelect.value;
  state.restPosePreset = null;
  state.restPoseBuiltin = false;
  if (!value){
    updateButtons();
    return null;
  }

  let data = null;
  if (value.startsWith("builtin:")){
    state.restPoseBuiltin = true;
    const file = value.slice("builtin:".length);
    const res = await fetch(`./rest_pose_presets/${file}`,{cache:"no-store"});
    if (!res.ok) throw new Error(`No pude cargar rest pose ${file}: HTTP ${res.status}`);
    data = await res.json();
  } else if (value.startsWith("custom:")){
    const i = Number(value.slice("custom:".length));
    if (state.customRestPoses[i]) data = structuredClone(state.customRestPoses[i]);
  }

  if (!data) return null;
  state.restPosePreset = data;

  // BlendCap v5 stores this flag with each preset. Old presets without
  // the field historically behaved as full loc/scale.
  els.includeRestLocScale.checked = data.include_loc_scale === undefined
    ? true
    : Boolean(data.include_loc_scale);

  if (!builtInRestPoseCompatible()){
    els.useCustomRest.checked = false;
    setStatus(
      `${data.name} pertenece al Source de BlendCap y no se aplicará sobre este Source Mixamo. Se usará el bind/rest pose original del FBX.`,
      "error"
    );
  }

  updateRestPoseControls();
  updateButtons();
  return data;
}

function updateRestPoseControls(){
  const anyRest = els.useCurrentRest.checked || els.useCustomRest.checked;
  els.includeRestLocScale.disabled = !anyRest;
  els.restPoseSelect.disabled = !els.useCustomRest.checked
    || !(state.restPoseManifest.length || state.customRestPoses.length);
  els.previewRestBtn.disabled = state.busy
    || !state.sourceRig
    || !els.useCustomRest.checked
    || !state.restPosePreset
    || !builtInRestPoseCompatible();
  els.saveRestBtn.disabled = state.busy || !state.sourceRig;
}

function previewSelectedRestPose(){
  if (!state.sourceRig || !state.restPosePreset) return;
  if (!builtInRestPoseCompatible()){
    setStatus(
      `${state.restPosePreset.name || "Rest Pose"} no es compatible con este Source Mixamo. Usa el bind/rest pose original del FBX o guarda/importa una pose propia.`,
      "error"
    );
    return;
  }
  state.playing = false;
  els.playBtn.textContent = "▶";
  try{
    const count = previewRestPosePreset(state.sourceRig,state.restPosePreset,{
      sourcePrefix:els.sourcePrefix.value || "",
      includeLocScale:els.includeRestLocScale.checked
    });
    setStatus(`Preview de "${state.restPosePreset.name || "Rest Pose"}": ${count} huesos aplicados. Mover el timeline restaura la animación.`,"success");
  }catch(err){
    console.error(err);
    setStatus(err.message || String(err),"error");
  }
}

function saveCurrentRestPose(){
  if (!state.sourceRig) return;
  const name = prompt("Nombre del rest-pose preset:","Mi Rest Pose");
  if (!name) return;
  try{
    const data = captureRestPosePreset(state.sourceRig,{
      name,
      includeLocScale:els.includeRestLocScale.checked,
      sourcePrefix:els.sourcePrefix.value || ""
    });
    if (!Object.keys(data.bones || {}).length){
      setStatus("La pose actual coincide con el rest pose importado; no hay cambios que guardar.","error");
      return;
    }
    state.customRestPoses.push(data);
    persistCustomRestPoses();
    renderRestPoseSelect();
    els.restPoseSelect.value = `custom:${state.customRestPoses.length-1}`;
    state.restPosePreset = data;
    state.restPoseBuiltin = false;
    els.useCustomRest.checked = true;
    els.useCurrentRest.checked = false;
    updateRestPoseControls();
    const blob = new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    downloadBlob(blob,`${safeBaseName(name)}.rest-pose.json`);
    setStatus(`Rest pose "${name}" guardado localmente y descargado como JSON.`,"success");
  }catch(err){
    console.error(err);
    setStatus(err.message || String(err),"error");
  }
}

function renderPresetSelect(){
  const current = els.presetSelect.value;
  els.presetSelect.innerHTML = '<option value="">— Sin preset —</option>';

  if (state.presetManifest.length){
    const standard = document.createElement("optgroup");
    standard.label = "Standard Presets";
    state.presetManifest.forEach(p => standard.appendChild(new Option(p.name,`builtin:${p.file}`)));
    els.presetSelect.appendChild(standard);
  }
  if (state.customPresets.length){
    const custom = document.createElement("optgroup");
    custom.label = "Custom Presets";
    state.customPresets.forEach((p,i) => custom.appendChild(new Option(p.name || `Custom ${i+1}`,`custom:${i}`)));
    els.presetSelect.appendChild(custom);
  }
  if ([...els.presetSelect.options].some(o => o.value === current)) els.presetSelect.value = current;
}

async function loadSelectedPreset(){
  const value = els.presetSelect.value;
  if (!value) return;
  if (value.startsWith("builtin:")){
    const file = value.slice("builtin:".length);
    const res = await fetch(`./presets/${file}`,{cache:"no-store"});
    if (!res.ok) throw new Error(`No pude cargar ${file}: HTTP ${res.status}`);
    applyPresetData(await res.json(),"Preset");
  } else if (value.startsWith("custom:")){
    const i = Number(value.slice("custom:".length));
    const data = state.customPresets[i];
    if (data) applyPresetData(structuredClone(data),"Custom preset");
  }
}

function mapConfig(name=""){
  const {sourcePrefix,targetPrefix} = currentPrefixes();
  return {
    name:name || state.preset?.name || "Custom Web Retarget Map",
    axis_convention:"THREE_Y_UP",
    target_kind:state.preset?.target_kind || "generic",
    sourcePrefix,targetPrefix,
    autoBakeIk:els.autoBakeIk.checked,
    headSource:els.headSource.value,
    headTarget:els.headTarget.value,
    useWorldLocation:els.useWorldLocation.checked,
    faceSettings:faceSettings(),
    ikChains:state.ikChains,
    pairs:state.pairs
  };
}

function saveCustomPreset(){
  const name = prompt("Nombre del preset:",state.preset?.name ? `${state.preset.name} Web` : "Mi retarget map");
  if (!name) return;
  const data = serializeMap(mapConfig(name));
  state.customPresets.push(data);
  persistCustomPresets();
  renderPresetSelect();
  els.presetSelect.value = `custom:${state.customPresets.length-1}`;
  const blob = new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  downloadBlob(blob,`${safeBaseName(name)}.json`);
  setStatus(`Preset "${name}" guardado en el navegador y descargado como JSON.`,"success");
}

function duration(){
  return state.sourceClip?.duration || state.retargetClip?.duration || 0;
}

function updateTransport(){
  const d = duration();
  els.timeline.max = String(Math.max(d,0.001));
  els.timeline.value = String(Math.min(state.currentTime,d));
  els.timeLabel.textContent = `${state.currentTime.toFixed(2)} / ${d.toFixed(2)} s`;
  els.playBtn.disabled = !state.sourceClip;
}

function seek(time){
  const d = duration();
  state.currentTime = Math.max(0,Math.min(Number(time) || 0,d));
  if (state.sourceRig && state.sourceClip){
    if (state.sourceRig.activeClip !== state.sourceClip){
      resetRigToRest(state.sourceRig);
      activateClip(state.sourceRig,state.sourceClip);
    }
    setRigTime(state.sourceRig,state.currentTime);
  }
  if (state.targetRig && state.retargetClip){
    if (state.targetRig.activeClip !== state.retargetClip) activateClip(state.targetRig,state.retargetClip);
    setRigTime(state.targetRig,state.currentTime);
  }
  updateTransport();
}

function setBusy(busy){
  state.busy = busy;
  updateButtons();
}

function resolvableIkChainCount(){
  if (!state.targetRig || !state.ikChains.length) return 0;
  const prefix = els.targetPrefix.value || "";
  let count = 0;
  for (const chain of state.ikChains){
    const control = resolveBone(state.targetRig,chain.ik_control || "",prefix);
    const pole = resolveBone(state.targetRig,chain.pole_control || "",prefix);
    if (control || pole) count++;
  }
  return count;
}

function updateButtons(){
  const {sourcePrefix,targetPrefix} = currentPrefixes();
  const valid = countValidPairs(state.pairs,state.sourceRig,state.targetRig,sourcePrefix,targetPrefix).valid;
  const customRestReady = !els.useCustomRest.checked
    || Boolean(state.restPosePreset);
  els.applyBtn.disabled = state.busy || !state.sourceRig || !state.targetRig || !state.sourceClip || valid === 0 || !customRestReady;
  els.applyBtn.title = valid === 0
    ? "No hay pares válidos para retargetear."
    : "Aplicar los pares válidos. Los dedos faltantes no bloquean el cuerpo.";
  const ikReady = resolvableIkChainCount();
  els.convertIkBtn.disabled = state.busy || !state.targetRig || !state.retargetClip || ikReady === 0;
  els.convertIkBtn.title = ikReady
    ? `${ikReady} cadena(s) IK resolubles en el Target FBX`
    : "El Target FBX no contiene controles IK utilizables; el retarget FK/deform sigue funcionando.";
  els.exportGlbBtn.disabled = state.busy || !state.targetRig || !state.retargetClip;
  els.exportClipBtn.disabled = state.busy || !state.retargetClip;
  updateRestPoseControls();
}

async function applyRetarget(){
  if (state.busy) return;
  state.playing = false;
  els.playBtn.textContent = "▶";
  setBusy(true);
  hideProgress();

  try{
    const {sourcePrefix,targetPrefix} = currentPrefixes();
    const coverage = detailedMappingCoverage();

    // Finger mappings are optional, and CloudRig/Rigify FBXs frequently
    // rename/split several limb deform bones. Do not hard-block a useful
    // partial body bake while the resolver is still able to drive enough
    // weighted bones. Only reject a truly unusable map.
    if (coverage.coreTotal >= 6 && coverage.coreValid < Math.min(6,coverage.coreTotal)){
      throw new Error(
        `Solo se resolvieron ${coverage.coreValid}/${coverage.coreTotal} huesos del cuerpo; no hay suficiente información para un retarget útil.`
      );
    }

    const restTime = state.currentTime;
    const useSavedRest = els.useCustomRest.checked
      && state.restPosePreset
      && builtInRestPoseCompatible();

    const result = await bakeRetarget({
      sourceRig:state.sourceRig,
      targetRig:state.targetRig,
      sourceClip:state.sourceClip,
      pairs:state.pairs,
      sourcePrefix,targetPrefix,
      fps:Number(els.fpsInput.value) || 30,
      autoScale:els.autoScale.checked,
      useCurrentSourcePoseAsRest:els.useCurrentRest.checked,
      restPosePreset:useSavedRest ? state.restPosePreset : null,
      includeRestLocationScale:els.includeRestLocScale.checked,
      sourceRestTime:restTime,
      useWorldLocation:els.useWorldLocation.checked,
      headSource:els.headSource.value,
      headTarget:els.headTarget.value,
      faceSettings:faceSettings(),
      onProgress:setProgress
    });
    state.retargetClip = result.clip;

    const redirectedText = coverage.redirected
      ? ` ${coverage.redirected} controles fueron redirigidos a deform bones skinned.`
      : "";
    const unresolvedText = coverage.unresolvedCore?.length
      ? ` Sin resolver: ${coverage.unresolvedCore.slice(0,6).join(", ")}${coverage.unresolvedCore.length > 6 ? "…" : ""}`
      : "";
    const scaleMethod = result.locationScaleMethod
      ? ` (${result.locationScaleMethod}${result.locationScaleSamples ? `, n=${result.locationScaleSamples}` : ""})`
      : "";
    const rootMotionText = result.rootMotionChannels
      ? ` Root motion LOC: ${result.rootMotionChannels} canal(es) sobre el objeto completo${result.rootMotionSources?.length ? ` desde ${result.rootMotionSources.join(", ")}` : ""}.`
      : "";
    const rootRotationText = result.rootRotationChannels
      ? ` Root motion ROT: ${result.rootRotationChannels} canal(es) sobre el objeto completo${result.rootRotationSources?.length ? ` desde ${result.rootRotationSources.join(", ")}` : ""}${result.rootRotationMode ? ` [${result.rootRotationMode}]` : ""}.`
      : "";
    const rootTranslationText = result.rootMotionChannels && result.rootTranslationMode
      ? ` Root translation mode: ${result.rootTranslationMode}.`
      : "";
    const pelvisSafetyText = result.pelvisTranslationRedirectedToRoot
      ? " Hips location se aplicó al objeto completo, no al DEF-Hips."
      : "";
    const splitRootText = result.splitRootMappings?.length
      ? ` Set-as-Root separado: ${result.splitRootMappings.join("; ")} (ROT al deform, LOC al objeto).`
      : "";
    const collapsedText = result.collapsedRotationTargets?.length
      ? ` Controles colapsados en FBX: ${result.collapsedRotationTargets
          .map(x => `${x.sources.join("+")}→${x.target}`)
          .join("; ")}.`
      : "";
    let message = `Retarget FK terminado: ${result.validPairs}/${result.totalPairs} pares, cuerpo ${coverage.coreValid}/${coverage.coreTotal}, dedos ${coverage.fingerValid}/${coverage.fingerTotal}, ${result.frameCount} frames, scale ${result.locationScale.toFixed(4)}${scaleMethod}.${rootMotionText}${rootRotationText}${rootTranslationText}${pelvisSafetyText}${splitRootText}${collapsedText}${redirectedText}${unresolvedText}`;

    if (els.autoBakeIk.checked && state.ikChains.length){
      try{
        const ik = await bakeIkIntoClip({
          targetRig:state.targetRig,
          clip:state.retargetClip,
          pairs:state.pairs,
          ikChains:state.ikChains,
          targetPrefix,
          fps:Number(els.fpsInput.value) || 30,
          onProgress:setProgress
        });
        state.retargetClip = ik.clip;
        message += ` FK→IK: ${ik.chains} cadenas horneadas.`;
      }catch(ikErr){
        console.warn("Auto FK→IK skipped",ikErr);
        message += ` FK→IK omitido: ${ikErr.message || ikErr}`;
      }
    }

    activateClip(state.targetRig,state.retargetClip);
    state.currentTime = 0;
    seek(0);
    setStatus(message,"success");
  }catch(err){
    console.error(err);
    setStatus(err.message || String(err),"error");
  }finally{
    setBusy(false);
    hideProgress();
    updateButtons();
  }
}

async function convertIk(){
  if (!state.retargetClip || state.busy) return;
  state.playing = false;
  setBusy(true);
  try{
    const result = await bakeIkIntoClip({
      targetRig:state.targetRig,
      clip:state.retargetClip,
      pairs:state.pairs,
      ikChains:state.ikChains,
      targetPrefix:els.targetPrefix.value || "",
      fps:Number(els.fpsInput.value) || 30,
      onProgress:setProgress
    });
    state.retargetClip = result.clip;
    activateClip(state.targetRig,state.retargetClip);
    seek(0);
    setStatus(`FK → IK horneado en ${result.chains} cadenas.`,"success");
  }catch(err){
    console.error(err);
    setStatus(err.message || String(err),"error");
  }finally{
    setBusy(false);
    hideProgress();
  }
}

async function exportGlb(){
  if (!state.targetRig || !state.retargetClip) return;
  const clip = state.retargetClip;
  state.playing = false;
  setBusy(true);
  setStatus("Preparando GLB…");
  try{
    resetRigToRest(state.targetRig);

    // White is viewport-only. Preserve the Target's actual materials in the
    // exported GLB and immediately return to solid white afterwards.
    restoreOriginalViewportMaterials(state.targetRig.root);

    const exporter = new GLTFExporter();
    const data = await exporter.parseAsync(state.targetRig.root,{
      binary:true,
      trs:true,
      onlyVisible:false,
      animations:[clip],
      includeCustomExtensions:true
    });
    const name = safeBaseName(state.targetRig.fileName || "target") + "_retargeted.glb";
    downloadBlob(new Blob([data],{type:"model/gltf-binary"}),name);

    applySolidWhiteViewport(state.targetRig.root);
    activateClip(state.targetRig,clip);
    seek(0);
    setStatus(`GLB exportado: ${name}`,"success");
  }catch(err){
    console.error(err);
    applySolidWhiteViewport(state.targetRig.root);
    setStatus(`Falló la exportación GLB: ${err.message || err}`,"error");
  }finally{
    setBusy(false);
  }
}

function exportClipJson(){
  if (!state.retargetClip) return;
  const json = state.retargetClip.toJSON ? state.retargetClip.toJSON() : THREE.AnimationClip.toJSON(state.retargetClip);
  const name = safeBaseName(state.targetRig?.fileName || "target") + "_retargeted.animation.json";
  downloadBlob(new Blob([JSON.stringify(json,null,2)],{type:"application/json"}),name);
}

function setupDropZone(element,kind){
  element.addEventListener("dragover",e => {
    e.preventDefault();
    element.classList.add("dragover");
  });
  element.addEventListener("dragleave",() => element.classList.remove("dragover"));
  element.addEventListener("drop",async e => {
    e.preventDefault();
    element.classList.remove("dragover");
    const file = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith(".fbx"));
    if (!file) return setStatus("Suelta un archivo .fbx.","error");
    try{ await loadFbx(file,kind); }
    catch(err){ console.error(err); setStatus(err.message || String(err),"error"); }
  });
}

els.sourceFile.addEventListener("change",async () => {
  try{ await loadFbx(els.sourceFile.files[0],"Source"); }
  catch(err){ console.error(err);setStatus(err.message || String(err),"error"); }
});
els.targetFile.addEventListener("change",async () => {
  try{ await loadFbx(els.targetFile.files[0],"Target"); }
  catch(err){ console.error(err);setStatus(err.message || String(err),"error"); }
});
setupDropZone(els.sourceViewport,"Source");
setupDropZone(els.targetViewport,"Target");

els.sourceClipSelect.addEventListener("change",() => {
  const clip = state.sourceRig?.animations[Number(els.sourceClipSelect.value)] || null;
  state.sourceClip = clip;
  state.retargetClip = null;
  if (clip) activateClip(state.sourceRig,clip);
  if (state.targetRig) resetRigToRest(state.targetRig);
  state.currentTime = 0;
  updateTransport();
  updateButtons();
});
els.presetSelect.addEventListener("change",async () => {
  try{ await loadSelectedPreset(); }
  catch(err){ console.error(err);setStatus(err.message || String(err),"error"); }
});
els.reloadPresetBtn.addEventListener("click",async () => {
  try{ await loadSelectedPreset(); }
  catch(err){ setStatus(err.message || String(err),"error"); }
});
els.savePresetBtn.addEventListener("click",saveCustomPreset);
els.presetFile.addEventListener("change",async () => {
  const file = els.presetFile.files[0];
  if (!file) return;
  try{
    const raw = await file.text();
    const isBmap = file.name.toLowerCase().endsWith(".bmap");
    const data = isBmap
      ? parseAutoRigProBmap(raw,file.name)
      : JSON.parse(raw);

    applyPresetData(data,isBmap ? "Auto-Rig Pro .bmap importado" : "JSON importado");
    state.customPresets.push(data);
    persistCustomPresets();
    renderPresetSelect();
    els.presetSelect.value = `custom:${state.customPresets.length-1}`;
  }catch(err){
    setStatus(`Preset inválido: ${err.message || err}`,"error");
  }
  els.presetFile.value = "";
});

els.useCurrentRest.addEventListener("change",() => {
  if (els.useCurrentRest.checked) els.useCustomRest.checked = false;
  updateRestPoseControls();
  updateButtons();
});
els.useCustomRest.addEventListener("change",async () => {
  if (els.useCustomRest.checked){
    els.useCurrentRest.checked = false;
    if (!els.restPoseSelect.value){
      const first = [...els.restPoseSelect.options].find(o => o.value);
      if (first) els.restPoseSelect.value = first.value;
    }
    if (els.restPoseSelect.value && !state.restPosePreset){
      try{ await loadSelectedRestPose(); }
      catch(err){ setStatus(err.message || String(err),"error"); }
    }
  }
  updateRestPoseControls();
  updateButtons();
});
els.restPoseSelect.addEventListener("change",async () => {
  try{
    await loadSelectedRestPose();
    if (state.restPosePreset){
      setStatus(`Rest pose seleccionado: ${state.restPosePreset.name || "preset"}.`,"success");
    }
  }catch(err){
    console.error(err);
    setStatus(err.message || String(err),"error");
  }
});
els.previewRestBtn.addEventListener("click",previewSelectedRestPose);
els.saveRestBtn.addEventListener("click",saveCurrentRestPose);
els.restPoseFile.addEventListener("change",async () => {
  const file = els.restPoseFile.files[0];
  if (!file) return;
  try{
    const data = JSON.parse(await file.text());
    if (!data || typeof data.bones !== "object"){
      throw new Error("El JSON no contiene un bloque bones de rest pose.");
    }
    data.name ||= file.name.replace(/\.json$/i,"");
    state.customRestPoses.push(data);
    persistCustomRestPoses();
    renderRestPoseSelect();
    els.restPoseSelect.value = `custom:${state.customRestPoses.length-1}`;
    state.restPosePreset = data;
    state.restPoseBuiltin = false;
    els.useCustomRest.checked = true;
    els.useCurrentRest.checked = false;
    els.includeRestLocScale.checked = data.include_loc_scale === undefined
      ? true
      : Boolean(data.include_loc_scale);
    updateRestPoseControls();
    updateButtons();
    setStatus(`Rest pose importado: ${data.name}.`,"success");
  }catch(err){
    console.error(err);
    setStatus(`Rest pose JSON inválido: ${err.message || err}`,"error");
  }
  els.restPoseFile.value = "";
});

els.sourcePrefix.addEventListener("input",() => { renderMappings();updateValidCount(); });
els.targetPrefix.addEventListener("input",() => { renderMappings();updateValidCount(); });
els.mapSearch.addEventListener("input",renderMappings);
els.addPairBtn.addEventListener("click",() => {
  state.pairs.push(normalizePair());
  renderMappings();updateValidCount();
});
els.addAllBtn.addEventListener("click",addAllSourceBones);
els.autoMatchBtn.addEventListener("click",autoMatch);
els.sortBtn.addEventListener("click",() => {
  state.pairs.sort((a,b) => a.source.localeCompare(b.source,undefined,{numeric:true,sensitivity:"base"}));
  renderMappings();
});
els.clearMapBtn.addEventListener("click",() => {
  state.pairs = [];
  renderMappings();updateValidCount();
});
els.copyBoneMapBtn.addEventListener("click",copyBoneMapDiagnostic);

els.facePerRegion.addEventListener("change",renderFaceRegions);
els.addIkChainBtn.addEventListener("click",() => {
  state.ikChains.push(normalizeIkChain());
  renderIkRows();updateButtons();
});
els.applyBtn.addEventListener("click",applyRetarget);
els.convertIkBtn.addEventListener("click",convertIk);
els.exportGlbBtn.addEventListener("click",exportGlb);
els.exportClipBtn.addEventListener("click",exportClipJson);
els.frameSourceBtn.addEventListener("click",() => {
  sourceView.frame();
  syncViewportCamera(sourceView,targetView);
});
els.frameTargetBtn.addEventListener("click",() => {
  targetView.frame();
  syncViewportCamera(targetView,sourceView);
});
els.syncCameras.addEventListener("change",() => {
  if (els.syncCameras.checked && state.sourceRig && state.targetRig){
    syncViewportCamera(sourceView,targetView);
    setStatus("Mirror cámaras activado: órbita, zoom y paneo quedan vinculados.","success");
  }else if (!els.syncCameras.checked){
    setStatus("Mirror cámaras desactivado. Cada viewport puede moverse de forma independiente.");
  }
});

els.timeline.addEventListener("input",() => {
  state.playing = false;
  els.playBtn.textContent = "▶";
  seek(Number(els.timeline.value));
});
els.playBtn.addEventListener("click",() => {
  if (!state.sourceClip) return;
  state.playing = !state.playing;
  els.playBtn.textContent = state.playing ? "❚❚" : "▶";
  state.lastTick = performance.now();
});

function animate(now){
  const dt = Math.min(.1,(now-state.lastTick)/1000);
  state.lastTick = now;
  if (state.playing && !state.busy){
    const d = duration();
    if (d > 0){
      let next = state.currentTime + dt;
      if (next > d) next = 0;
      seek(next);
    }
  }
  sourceView.render();
  targetView.render();
  requestAnimationFrame(animate);
}

renderFaceRegions();
renderIkRows();
renderMappings();
updateTransport();
updateButtons();
loadPresetManifest();
loadRestPoseManifest();
requestAnimationFrame(animate);
