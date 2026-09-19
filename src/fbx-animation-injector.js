const DECODER = new TextDecoder("utf-8");
const ENCODER = new TextEncoder();
const MAGIC = "Kaydara FBX Binary  \u0000\u001a\u0000";
const ANIM_TYPES = new Set([
  "AnimationStack",
  "AnimationLayer",
  "AnimationCurveNode",
  "AnimationCurve"
]);

function headerSize(version){
  return version >= 7500 ? 25 : 13;
}

function isZeroRange(bytes,offset,length){
  if (offset < 0 || offset + length > bytes.length) return false;
  for (let i=0;i<length;i++){
    if (bytes[offset+i] !== 0) return false;
  }
  return true;
}

function readString(bytes,offset,length){
  return DECODER.decode(bytes.subarray(offset,offset+length));
}

function readProp(bytes,view,offset){
  const start = offset;
  const type = String.fromCharCode(bytes[offset++]);
  let value;

  switch(type){
    case "Y":
      value = view.getInt16(offset,true); offset += 2; break;
    case "C":
      value = bytes[offset] !== 0; offset += 1; break;
    case "I":
      value = view.getInt32(offset,true); offset += 4; break;
    case "F":
      value = view.getFloat32(offset,true); offset += 4; break;
    case "D":
      value = view.getFloat64(offset,true); offset += 8; break;
    case "L":
      value = view.getBigInt64(offset,true); offset += 8; break;
    case "S":
    case "R": {
      const length = view.getUint32(offset,true); offset += 4;
      const rawValue = bytes.subarray(offset,offset+length); offset += length;
      value = type === "S" ? DECODER.decode(rawValue) : rawValue.slice();
      break;
    }
    case "f":
    case "d":
    case "l":
    case "i":
    case "b":
    case "c": {
      const length = view.getUint32(offset,true);
      const encoding = view.getUint32(offset+4,true);
      const compressedLength = view.getUint32(offset+8,true);
      offset += 12 + compressedLength;
      value = {length,encoding,compressedLength};
      break;
    }
    default:
      throw new Error("FBX property type no soportado: " + type);
  }

  return {
    prop:{
      type,
      value,
      raw:bytes.slice(start,offset),
      dirty:false
    },
    offset
  };
}

function parseNode(bytes,view,offset,version){
  const start = offset;
  const wide = version >= 7500;
  const hSize = headerSize(version);

  let endOffset;
  let propCount;
  let propListLength;

  if (wide){
    endOffset = Number(view.getBigUint64(offset,true)); offset += 8;
    propCount = Number(view.getBigUint64(offset,true)); offset += 8;
    propListLength = Number(view.getBigUint64(offset,true)); offset += 8;
  } else {
    endOffset = view.getUint32(offset,true); offset += 4;
    propCount = view.getUint32(offset,true); offset += 4;
    propListLength = view.getUint32(offset,true); offset += 4;
  }

  const nameLength = bytes[offset++];
  if (
    endOffset === 0
    && propCount === 0
    && propListLength === 0
    && nameLength === 0
  ){
    return {node:null,offset:start+hSize};
  }

  if (endOffset <= start || endOffset > bytes.length){
    throw new Error("FBX corrupto: EndOffset inválido.");
  }

  const name = readString(bytes,offset,nameLength);
  offset += nameLength;

  const props = [];
  for (let i=0;i<propCount;i++){
    const parsed = readProp(bytes,view,offset);
    props.push(parsed.prop);
    offset = parsed.offset;
  }

  const children = [];
  let hadNull = false;

  while (offset < endOffset){
    if (isZeroRange(bytes,offset,hSize)){
      hadNull = true;
      offset += hSize;
      break;
    }
    const parsed = parseNode(bytes,view,offset,version);
    if (!parsed.node){
      hadNull = true;
      offset = parsed.offset;
      break;
    }
    children.push(parsed.node);
    offset = parsed.offset;
  }

  if (offset !== endOffset){
    throw new Error(
      "FBX corrupto: nodo " + name + " terminó en "
      + offset + " pero esperaba " + endOffset + "."
    );
  }

  return {
    node:{name,props,children,hadNull},
    offset
  };
}

export function parseBinaryFbx(input){
  const bytes = input instanceof Uint8Array
    ? input
    : new Uint8Array(input);

  if (bytes.length < 40){
    throw new Error("FBX demasiado pequeño.");
  }

  const magic = DECODER.decode(bytes.subarray(0,23));
  if (magic !== MAGIC){
    throw new Error("Solo se admite FBX binario.");
  }

  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const version = view.getUint32(23,true);
  const hSize = headerSize(version);

  let offset = 27;
  const roots = [];

  while (offset + hSize <= bytes.length){
    if (isZeroRange(bytes,offset,hSize)){
      offset += hSize;
      break;
    }

    const parsed = parseNode(bytes,view,offset,version);
    if (!parsed.node){
      offset = parsed.offset;
      break;
    }
    roots.push(parsed.node);
    offset = parsed.offset;
  }

  return {
    version,
    header:bytes.slice(0,27),
    roots,
    tail:bytes.slice(offset)
  };
}

function encodeProp(prop){
  if (prop.raw && !prop.dirty) return prop.raw;

  const type = prop.type;
  let out;
  let view;

  switch(type){
    case "Y":
      out = new Uint8Array(3);
      out[0] = "Y".charCodeAt(0);
      new DataView(out.buffer).setInt16(1,Number(prop.value),true);
      return out;
    case "C":
      out = new Uint8Array(2);
      out[0] = "C".charCodeAt(0);
      out[1] = prop.value ? 1 : 0;
      return out;
    case "I":
      out = new Uint8Array(5);
      out[0] = "I".charCodeAt(0);
      new DataView(out.buffer).setInt32(1,Number(prop.value),true);
      return out;
    case "F":
      out = new Uint8Array(5);
      out[0] = "F".charCodeAt(0);
      new DataView(out.buffer).setFloat32(1,Number(prop.value),true);
      return out;
    case "D":
      out = new Uint8Array(9);
      out[0] = "D".charCodeAt(0);
      new DataView(out.buffer).setFloat64(1,Number(prop.value),true);
      return out;
    case "L":
      out = new Uint8Array(9);
      out[0] = "L".charCodeAt(0);
      new DataView(out.buffer).setBigInt64(1,BigInt(prop.value),true);
      return out;
    case "S":
    case "R": {
      const payload = type === "S"
        ? ENCODER.encode(String(prop.value))
        : (prop.value instanceof Uint8Array
          ? prop.value
          : new Uint8Array(prop.value || []));
      out = new Uint8Array(5 + payload.length);
      out[0] = type.charCodeAt(0);
      new DataView(out.buffer).setUint32(1,payload.length,true);
      out.set(payload,5);
      return out;
    }
    default:
      throw new Error(
        "No se puede reescribir propiedad FBX de tipo " + type
        + "; las arrays originales deben conservar raw."
      );
  }
}

function cloneProp(prop){
  return {
    type:prop.type,
    value:prop.value instanceof Uint8Array ? prop.value.slice() : prop.value,
    raw:prop.raw ? prop.raw.slice() : null,
    dirty:Boolean(prop.dirty)
  };
}

function cloneNode(node){
  return {
    name:node.name,
    props:node.props.map(cloneProp),
    children:node.children.map(cloneNode),
    hadNull:Boolean(node.hadNull)
  };
}

function replaceProp(node,index,type,value){
  if (!node.props[index]){
    throw new Error("FBX: propiedad " + index + " ausente en " + node.name + ".");
  }
  node.props[index] = {
    type,
    value,
    raw:null,
    dirty:true
  };
}

function propBytes(prop){
  return encodeProp(prop);
}

function measureNode(node,version){
  const hSize = headerSize(version);
  const nameBytes = ENCODER.encode(node.name);
  if (nameBytes.length > 255){
    throw new Error("FBX: nombre de nodo demasiado largo: " + node.name);
  }

  const pBytes = node.props.map(propBytes);
  let total = hSize + nameBytes.length;
  for (const p of pBytes) total += p.length;
  for (const child of node.children) total += measureNode(child,version);
  if (node.hadNull || node.children.length) total += hSize;

  node.__fbxMeasure = {total,nameBytes,pBytes};
  return total;
}

function writeNode(node,version,out,view,start){
  const wide = version >= 7500;
  const hSize = headerSize(version);
  const m = node.__fbxMeasure || (() => {
    measureNode(node,version);
    return node.__fbxMeasure;
  })();

  const end = start + m.total;
  let offset = start;

  if (wide){
    view.setBigUint64(offset,BigInt(end),true); offset += 8;
    view.setBigUint64(offset,BigInt(node.props.length),true); offset += 8;
    const propLen = m.pBytes.reduce((a,b) => a+b.length,0);
    view.setBigUint64(offset,BigInt(propLen),true); offset += 8;
  } else {
    view.setUint32(offset,end,true); offset += 4;
    view.setUint32(offset,node.props.length,true); offset += 4;
    const propLen = m.pBytes.reduce((a,b) => a+b.length,0);
    view.setUint32(offset,propLen,true); offset += 4;
  }

  out[offset++] = m.nameBytes.length;
  out.set(m.nameBytes,offset);
  offset += m.nameBytes.length;

  for (const p of m.pBytes){
    out.set(p,offset);
    offset += p.length;
  }

  for (const child of node.children){
    offset = writeNode(child,version,out,view,offset);
  }

  if (node.hadNull || node.children.length){
    out.fill(0,offset,offset+hSize);
    offset += hSize;
  }

  if (offset !== end){
    throw new Error("FBX writer desalineado en " + node.name + ".");
  }
  return offset;
}

export function writeBinaryFbx(doc){
  const version = doc.version;
  const hSize = headerSize(version);
  let total = 27 + hSize + doc.tail.length;

  for (const node of doc.roots){
    total += measureNode(node,version);
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(doc.header,0);

  let offset = 27;
  for (const node of doc.roots){
    offset = writeNode(node,version,out,view,offset);
  }

  out.fill(0,offset,offset+hSize);
  offset += hSize;

  out.set(doc.tail,offset);
  offset += doc.tail.length;

  if (offset !== out.length){
    throw new Error("FBX writer produjo un tamaño inconsistente.");
  }
  return out;
}

function rootNode(doc,name){
  return doc.roots.find(n => n.name === name) || null;
}

function childNodes(node,name){
  return node ? node.children.filter(n => n.name === name) : [];
}

function cleanObjectName(value){
  const s = String(value || "");
  const nul = s.indexOf("\u0000");
  return nul >= 0 ? s.slice(0,nul) : s;
}

function nodeObjectId(node){
  const p = node?.props?.[0];
  if (!p) return null;
  if (p.type === "L") return BigInt(p.value);
  if (p.type === "I") return BigInt(Number(p.value));
  return null;
}

function buildModelMaps(objects){
  const byId = new Map();
  const byName = new Map();
  const duplicates = new Set();

  for (const node of childNodes(objects,"Model")){
    const id = nodeObjectId(node);
    if (id == null) continue;

    const name = cleanObjectName(node.props?.[1]?.value);
    byId.set(id,{id,name,node});

    if (!name) continue;
    if (byName.has(name)) duplicates.add(name);
    else byName.set(name,{id,name,node});
  }

  for (const name of duplicates) byName.delete(name);
  return {byId,byName,duplicates};
}

function maxObjectId(objects){
  let max = 0n;
  for (const node of objects.children){
    const id = nodeObjectId(node);
    if (id != null && id > max) max = id;
  }
  return max;
}

function makeCountValue(node,delta){
  const p = node?.props?.[0];
  if (!p) throw new Error("FBX Definitions: Count sin valor.");
  const next = Number(p.value) + Number(delta);
  replaceProp(node,0,p.type,next);
}

function mergeDefinitions(original,donor,addedCounts){
  const originalDefs = rootNode(original,"Definitions");
  const donorDefs = rootNode(donor,"Definitions");
  if (!originalDefs || !donorDefs){
    throw new Error("FBX sin Definitions; no puedo inyectar AnimationStack.");
  }

  const totalCountNode = originalDefs.children.find(n => n.name === "Count");
  if (!totalCountNode){
    throw new Error("FBX Definitions sin Count.");
  }

  let totalAdded = 0;

  for (const type of ANIM_TYPES){
    const amount = addedCounts.get(type) || 0;
    if (!amount) continue;
    totalAdded += amount;

    const existing = originalDefs.children.find(
      n => n.name === "ObjectType" && String(n.props?.[0]?.value) === type
    );

    if (existing){
      const countNode = existing.children.find(n => n.name === "Count");
      if (!countNode){
        throw new Error("FBX Definitions/" + type + " sin Count.");
      }
      makeCountValue(countNode,amount);
      continue;
    }

    const donorType = donorDefs.children.find(
      n => n.name === "ObjectType" && String(n.props?.[0]?.value) === type
    );
    if (!donorType){
      throw new Error("El FBX donante no define " + type + ".");
    }

    const cloned = cloneNode(donorType);
    const countNode = cloned.children.find(n => n.name === "Count");
    if (countNode){
      replaceProp(
        countNode,
        0,
        countNode.props[0].type,
        amount
      );
    }
    originalDefs.children.push(cloned);
    originalDefs.hadNull = true;
  }

  makeCountValue(totalCountNode,totalAdded);
}

function collectAnimationObjects(objects){
  const nodes = objects.children.filter(n => ANIM_TYPES.has(n.name));
  const ids = new Set();
  const counts = new Map();

  for (const node of nodes){
    const id = nodeObjectId(node);
    if (id == null){
      throw new Error("Objeto de animación FBX sin ID: " + node.name);
    }
    ids.add(id);
    counts.set(node.name,(counts.get(node.name) || 0) + 1);
  }

  return {nodes,ids,counts};
}

function cloneConnectionWithRemap(
  connection,
  animIdMap,
  donorModels,
  originalModels,
  mappedTargets
){
  const clone = cloneNode(connection);
  if (clone.props.length < 3) return null;

  const src = BigInt(clone.props[1].value);
  const dst = BigInt(clone.props[2].value);

  const mapEndpoint = id => {
    if (animIdMap.has(id)) return animIdMap.get(id);
    if (id === 0n) return 0n;

    const donorModel = donorModels.byId.get(id);
    if (!donorModel){
      throw new Error(
        "Conexión de animación apunta a un objeto donante no mapeable: "
        + id.toString()
      );
    }

    if (originalModels.duplicates.has(donorModel.name)){
      throw new Error(
        "El Target original tiene nombre de hueso/modelo duplicado: "
        + donorModel.name
      );
    }

    const originalModel = originalModels.byName.get(donorModel.name);
    if (!originalModel){
      throw new Error(
        "La Action intenta animar " + donorModel.name
        + " pero ese Model no existe con ese nombre exacto en el FBX Target original."
      );
    }

    mappedTargets.add(donorModel.name);
    return originalModel.id;
  };

  replaceProp(clone,1,"L",mapEndpoint(src));
  replaceProp(clone,2,"L",mapEndpoint(dst));
  return clone;
}

export function injectAnimationIntoOriginalFbx(
  originalBytes,
  donorBytes,
  options={}
){
  const original = parseBinaryFbx(originalBytes);
  const donor = parseBinaryFbx(donorBytes);

  if (original.version !== donor.version){
    throw new Error(
      "Las versiones FBX no coinciden: Target "
      + original.version + " vs donante " + donor.version + "."
    );
  }

  const originalObjects = rootNode(original,"Objects");
  const donorObjects = rootNode(donor,"Objects");
  const originalConnections = rootNode(original,"Connections");
  const donorConnections = rootNode(donor,"Connections");

  if (
    !originalObjects || !donorObjects
    || !originalConnections || !donorConnections
  ){
    throw new Error("FBX sin Objects/Connections.");
  }

  const originalModels = buildModelMaps(originalObjects);
  const donorModels = buildModelMaps(donorObjects);
  const donorAnim = collectAnimationObjects(donorObjects);

  if (!donorAnim.nodes.length){
    throw new Error("El FBX donante no contiene AnimationStack/curvas.");
  }

  let nextId = maxObjectId(originalObjects) + 1n;
  const usedIds = new Set(
    originalObjects.children
      .map(nodeObjectId)
      .filter(v => v != null)
  );

  const animIdMap = new Map();
  for (const node of donorAnim.nodes){
    const oldId = nodeObjectId(node);
    while (usedIds.has(nextId)) nextId++;
    animIdMap.set(oldId,nextId);
    usedIds.add(nextId);
    nextId++;
  }

  const clonedAnimNodes = donorAnim.nodes.map(node => {
    const clone = cloneNode(node);
    const oldId = nodeObjectId(node);
    replaceProp(clone,0,"L",animIdMap.get(oldId));
    return clone;
  });

  const mappedTargets = new Set();
  const clonedConnections = [];

  for (const connection of childNodes(donorConnections,"C")){
    if (connection.props.length < 3) continue;

    const src = BigInt(connection.props[1].value);
    const dst = BigInt(connection.props[2].value);
    const touchesAnimation = donorAnim.ids.has(src) || donorAnim.ids.has(dst);

    if (!touchesAnimation) continue;

    clonedConnections.push(
      cloneConnectionWithRemap(
        connection,
        animIdMap,
        donorModels,
        originalModels,
        mappedTargets
      )
    );
  }

  if (!clonedConnections.length){
    throw new Error("No encontré conexiones de animación en el FBX donante.");
  }

  mergeDefinitions(original,donor,donorAnim.counts);

  originalObjects.children.push(...clonedAnimNodes);
  originalObjects.hadNull = true;

  originalConnections.children.push(...clonedConnections);
  originalConnections.hadNull = true;

  const output = writeBinaryFbx(original);

  // Re-parse our own result. This catches offset/length mistakes before the
  // user downloads a corrupt FBX.
  const verify = parseBinaryFbx(output);
  const verifyObjects = rootNode(verify,"Objects");
  const verifyAnim = collectAnimationObjects(verifyObjects);

  if (verifyAnim.nodes.length < donorAnim.nodes.length){
    throw new Error("Validación FBX falló después de inyectar la Action.");
  }

  return {
    bytes:output,
    diagnostics:{
      actionName:String(options.actionName || ""),
      originalModelCount:originalModels.byId.size,
      donorAnimationObjects:donorAnim.nodes.length,
      donorConnections:clonedConnections.length,
      mappedTargets:[...mappedTargets].sort(),
      outputBytes:output.byteLength,
      fbxVersion:original.version
    }
  };
}
