# retarget-to-see

Retargeting de animación 100% en el navegador para FBX.

## Qué hace

- Importa un **FBX Source** con animación y un **FBX Target**.
- Detecta y lista los huesos de ambos esqueletos.
- Permite mapear Source → Target por hueso.
- Carga presets compatibles con el esquema de retargeting de BlendCap.
- Auto-Match por nombre y namespaces/prefijos.
- Transfiere rotación con **world-space delta-from-rest**, evitando copiar el roll absoluto del Source.
- Transfiere posición por canales y ejes.
- Soporta pares **HEAD_LOCAL** para cara.
- Auto-scale por altura de esqueleto.
- Permite usar la pose actual del Source como rest pose.
- Incluye **Custom Rest Pose** con los presets T-POSE/A-POSE de BlendCap, preview, importación y guardado de poses propias, además de Location & Scale opcional.
- Puede hornear controles IK si el Target FBX realmente contiene esos controles.
- Preview sincronizado Source/Target.
- Exporta el Target retargeteado como **GLB** con la animación horneada.
- Guarda/carga mapas personalizados en JSON.

Todo el procesamiento se hace localmente en el navegador. No se suben los FBX a un servidor.

## Uso

Abre `index.html` desde GitHub Pages o un servidor estático, carga Source y Target, elige un preset o haz Auto-Match, corrige los pares necesarios y pulsa **Aplicar retargeting**.

## Limitación importante de FBX

BlendCap dentro de Blender puede animar controles de Rigify/Auto-Rig Pro/CloudRig porque Blender conserva constraints, drivers e IK del rig. Un FBX normalmente **no conserva ese sistema de control de Blender**. Esta web puede retargetear cualquier hueso que exista realmente en el FBX y puede hornear tracks para controles presentes, pero no puede reconstruir constraints/drivers que el FBX nunca exportó.

Para resultados fiables fuera de Blender, usa un Target FBX cuyo esqueleto deformante sea el que quieras animar, o exporta explícitamente los huesos/controladores que necesites.

## Licencia y atribución

Este proyecto es GPL-3.0. El algoritmo de retargeting, el esquema de presets y los presets incluidos están portados/adaptados a web a partir de **BlendCap** de Arcomade, también GPL-3.0:

https://github.com/Arcomade/BlendCap

La implementación web no ejecuta `bpy` ni Blender en WebAssembly; reimplementa el retargeting sobre Three.js y matrices/quaternions del esqueleto FBX. WASM no es necesario para el núcleo matemático actual; puede añadirse más adelante como optimización para clips muy densos.
