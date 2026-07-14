// Monad Passport — scroll-driven 3D showcase
//
// Plain ES modules + Three.js from CDN, no bundler. Must be served over
// HTTP (see index.html comment) because browsers block ES module imports
// on the file:// protocol.

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Fraction of the visible viewport height the model should occupy once framed.
const FILL_RATIO = 0.6;
// Base yaw so the passport's front cover faces the camera at page top.
// Adjust if the source export's default orientation ever changes.
const BASE_ROTATION_Y = -Math.PI / 2;
// Corrective pitch for the Blender (Z-up) export, which otherwise leaves the
// passport lying flat with its cover facing the sky. Starting guess: rotate
// -90° about X to stand it upright facing the camera.
// VERIFY IN BROWSER: if the back cover faces the camera or "PASSPORT" reads
// upside down, flip this to +Math.PI / 2 instead.
const CORRECTIVE_ROTATION_X = Math.PI;
// Corrective roll on the same wrapper: after standing the passport upright,
// it was left rotated 90° in-plane (text running vertically instead of
// horizontally). Starting guess: -90° about Z so the spine (binding edge)
// lands on the left, like a book seen face-on.
// VERIFY IN BROWSER: if text reads upside down or the spine ends up on the
// right, flip this to +Math.PI / 2. If neither sign looks right on Z, this
// roll may need to move to CORRECTIVE_ROTATION_X's Y equivalent instead —
// the X correction above changes which local axis this roll actually acts
// on in screen space.
const CORRECTIVE_ROTATION_Z = -Math.PI / 2;
// How quickly action.time eases toward its current target each frame (0-1).
// One factor, one lerp, used for both normal scroll-driven scrubbing and the
// inspect-mode display-pose swing (~0.5-0.6s to settle) — see animate().
const SCRUB_LERP_FACTOR = 0.1;
// Scroll progress at/above which inspect mode (free OrbitControls) takes over.
const INSPECT_THRESHOLD = 0.98;
// Fraction of the clip's duration used as the "display pose" action.time
// eases to while inspecting: the mid-closing 90°-open pose (~75%), which
// sits closer to the page-end (fully closed) state than the mid-opening
// 90°-open pose at ~25%, so the swing into position travels less distance.
// 0.25 is the equivalent alternative pose if the closer-to-open feel is preferred.
const DISPLAY_POSE_FRACTION = 0.75;
// How quickly the camera eases back to its resting pose after leaving inspect mode (0-1/frame).
const CAMERA_RESET_LERP_FACTOR = 0.1;
// Matches the CSS breakpoint that switches the hero/text layout to two columns.
const DESKTOP_MEDIA_QUERY = "(min-width: 900px)";
// On desktop the text column occupies the left 40% of the viewport, so the
// model should be horizontally centered in the middle of the remaining right
// 60% — i.e. at 40% + 60%/2 = 70% of viewport width instead of the default 50%.
const DESKTOP_MODEL_CENTER_FRACTION = 0.7;

// ---------- Module-level state ----------
let scene, camera, renderer;
let modelGroup;
let mixer, action, clip;
let controls;
let inspectMode = false;
let initialCameraPosition, initialCameraQuaternion;
let scrollProgress = 0; // 0 at top of page, 1 at bottom
let displayPoseTime = 0; // clip.duration * DISPLAY_POSE_FRACTION, set once the clip loads

const clock = new THREE.Clock();
const canvas = document.getElementById("scene-canvas");
const loadingIndicator = document.getElementById("loading-indicator");
const inspectHint = document.getElementById("inspect-hint");
const inspectExitButton = document.getElementById("inspect-exit");
const desktopMediaQuery = window.matchMedia(DESKTOP_MEDIA_QUERY);

// ---------- Scene setup ----------
function initScene() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(0, 0, 5);
  initialCameraPosition = camera.position.clone();
  initialCameraQuaternion = camera.quaternion.clone();

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x05050a, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Environment map so PBR/metallic materials have something to reflect —
  // without this, metallic surfaces render flat black.
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(
    new RoomEnvironment(),
    0.04
  ).texture;
  pmremGenerator.dispose();
}

// ---------- Lighting ----------
function initLights() {
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x1a1a2e, 0.6);
  scene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
  keyLight.position.set(3, 4, 5);
  scene.add(keyLight);
}

// ---------- Inspect-mode controls ----------
// OrbitControls power a "step outside the scroll timeline and look around"
// mode, only active once the scroll-driven animation has fully played.
function initControls() {
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enabled = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.enablePan = true;
  controls.screenSpacePanning = true; // pan along the screen plane, not the target's ground plane
  controls.panSpeed = 0.5; // keep panning modest relative to rotate/zoom

  // Placeholder distances until the model loads and frameModel() refines
  // them against its actual bounding box.
  const distance = camera.position.length();
  controls.minDistance = distance * 0.5;
  controls.maxDistance = distance * 3;
}

function setInspectMode(enabled) {
  if (enabled === inspectMode) return;

  inspectMode = enabled;
  controls.enabled = enabled;
  canvas.style.pointerEvents = enabled ? "auto" : "none";
  if (inspectHint) inspectHint.classList.toggle("is-visible", enabled);

  if (enabled) {
    // Orbit around the model's actual position, not the world origin — on
    // desktop the model is shifted off-center by updateModelLayout(), so
    // pivoting at (0,0,0) would swing it out of frame while orbiting.
    const pivotX = modelGroup ? modelGroup.position.x : 0;
    controls.target.set(pivotX, 0, 0);
  }
}

// ---------- Model loading ----------
// Recenters `object` at the origin and returns a scale that makes its
// largest bounding-box dimension fill FILL_RATIO of the camera's visible
// height at its current distance — derived from the model, not guessed.
// Also returns the model's world-space bounding radius (post-scale) so
// OrbitControls' zoom limits can be derived from it too.
function frameModel(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  object.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const distance = camera.position.z;
  const fovRadians = THREE.MathUtils.degToRad(camera.fov);
  const visibleHeight = 2 * Math.tan(fovRadians / 2) * distance;
  const scale = (visibleHeight * FILL_RATIO) / maxDim;

  const boundingRadius = box.getBoundingSphere(new THREE.Sphere()).radius * scale;

  return { scale, boundingRadius };
}

function hideLoadingIndicator() {
  if (loadingIndicator) loadingIndicator.classList.add("is-hidden");
}

function loadPassportModel() {
  const loader = new GLTFLoader();

  loader.load(
    "assets/passportanimation.glb",
    (gltf) => {
      // Debug: confirm the clip name/duration the scroll scrubber will use.
      console.log("Passport model animations:", gltf.animations);

      const model = gltf.scene;

      // Corrective wrapper for the Blender Z-up export, kept separate from
      // gltf.scene so the embedded cover-opening animation (which targets a
      // child node's own rotation) is unaffected by this parent-level fix.
      const correctionGroup = new THREE.Group();
      correctionGroup.add(model);
      correctionGroup.rotation.x = CORRECTIVE_ROTATION_X;
      correctionGroup.rotation.z = CORRECTIVE_ROTATION_Z;

      // Frame AFTER both corrective rotations so the bounding box reflects
      // the final upright, portrait pose, not an intermediate one. maxDim
      // inside frameModel is just the largest of the box's three extents,
      // so it (and therefore the resulting scale) is unaffected by which
      // world axis that extent now lands on — no separate camera-distance
      // change is needed for the portrait reorientation.
      const { scale, boundingRadius } = frameModel(correctionGroup);

      modelGroup = new THREE.Group();
      modelGroup.add(correctionGroup);
      modelGroup.scale.setScalar(scale);
      modelGroup.rotation.y = BASE_ROTATION_Y;
      scene.add(modelGroup);
      updateModelLayout(); // apply the desktop/mobile x offset as soon as the model exists

      // Now that the model's real size is known, keep orbit zoom from going
      // inside the passport or drifting off to an unreadable distance.
      controls.minDistance = boundingRadius * 1.4;
      controls.maxDistance = boundingRadius * 6;

      if (gltf.animations.length > 0) {
        clip = gltf.animations[0];
        displayPoseTime = clip.duration * DISPLAY_POSE_FRACTION;
        mixer = new THREE.AnimationMixer(model);
        action = mixer.clipAction(clip);
        action.play();
        action.paused = true; // scroll (or inspect mode) drives time — it must not play on its own
      }

      hideLoadingIndicator();
    },
    undefined,
    (error) => {
      console.error("Failed to load passport model:", error);
      hideLoadingIndicator(); // don't leave the page stuck behind the overlay
    }
  );
}

// ---------- Scroll tracking ----------
// Returns normalized scroll progress: 0 at the top of the page, 1 at the bottom.
function getScrollProgress() {
  const scrollableHeight =
    document.documentElement.scrollHeight - window.innerHeight;
  if (scrollableHeight <= 0) return 0;
  return window.scrollY / scrollableHeight;
}

function initScrollTracking() {
  window.addEventListener(
    "scroll",
    () => {
      scrollProgress = getScrollProgress();
      setInspectMode(scrollProgress >= INSPECT_THRESHOLD);
    },
    { passive: true }
  );
}

// Lets the user back out of inspect mode without having to find empty page
// space to scroll from — nudges scroll progress back below the threshold.
function initInspectExit() {
  if (!inspectExitButton) return;
  inspectExitButton.addEventListener("click", () => {
    window.scrollBy({ top: -200, left: 0, behavior: "smooth" });
  });
}

// Keeps the model's column offset in sync with the desktop/mobile
// breakpoint — covers window resizes that cross 900px and, on devices
// where that isn't a plain "resize" (e.g. some browsers on tablet
// rotation), the matchMedia change event fires either way.
function initResponsiveLayout() {
  desktopMediaQuery.addEventListener("change", updateModelLayout);
}

// ---------- Render loop ----------
function animate() {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();

  if (modelGroup) {
    // Subtle idle motion, small enough to stay out of the way of the
    // scroll-driven cover-opening animation (which lives on the mixer, not
    // on this group's transform).
    modelGroup.rotation.y =
      BASE_ROTATION_Y + Math.sin(elapsed * 0.4) * THREE.MathUtils.degToRad(3);
    modelGroup.position.y = Math.sin(elapsed * 0.6) * 0.03;
  }

  if (action) {
    // Single eased target for action.time: the scroll-driven position in
    // normal mode, or the fixed display pose while inspecting. Recomputed
    // fresh from current state every frame rather than stored as a
    // separate tween, so entering/leaving inspect mode just retargets the
    // same lerp — no stacked animations, no jump, and rapid toggling back
    // and forth simply redirects the ease instead of jittering.
    const targetActionTime = inspectMode
      ? displayPoseTime
      : scrollProgress * clip.duration;
    action.time = THREE.MathUtils.lerp(
      action.time,
      targetActionTime,
      SCRUB_LERP_FACTOR
    );
    mixer.update(0);
  }

  if (inspectMode) {
    controls.update();
  } else {
    // Ease the camera back to its resting pose after leaving inspect mode,
    // instead of snapping it back on the next scroll tick.
    camera.position.lerp(initialCameraPosition, CAMERA_RESET_LERP_FACTOR);
    camera.quaternion.slerp(initialCameraQuaternion, CAMERA_RESET_LERP_FACTOR);
  }

  renderer.render(scene, camera);
}

// ---------- Responsive model layout ----------
// World-space X offset that puts the model in the middle of the desktop
// text-free column, or 0 (screen center) below the breakpoint. Computed
// from the camera's frustum width at the model's viewing distance rather
// than a hardcoded pixel/world value, so it stays correct at any viewport
// size or aspect ratio.
function getModelOffsetX() {
  if (!desktopMediaQuery.matches) return 0;

  const distance = camera.position.z;
  const fovRadians = THREE.MathUtils.degToRad(camera.fov);
  const visibleHeight = 2 * Math.tan(fovRadians / 2) * distance;
  const visibleWidth = visibleHeight * camera.aspect;

  const shiftFraction = DESKTOP_MODEL_CENTER_FRACTION - 0.5;
  return shiftFraction * visibleWidth;
}

function updateModelLayout() {
  if (!modelGroup) return;
  modelGroup.position.x = getModelOffsetX();
}

// ---------- Resize handling ----------
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  updateModelLayout();
}

// ---------- Init ----------
function init() {
  initScene();
  initLights();
  initControls();
  initScrollTracking();
  initInspectExit();
  initResponsiveLayout();
  loadPassportModel();
  window.addEventListener("resize", onResize);
  animate();
}

init();
