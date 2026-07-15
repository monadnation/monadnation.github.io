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
// How quickly the shared action time eases toward the scroll-derived target
// each frame (0-1) — see animate().
const SCRUB_LERP_FACTOR = 0.1;
// Matches the CSS breakpoint that switches the hero/text layout to two columns.
const DESKTOP_MEDIA_QUERY = "(min-width: 900px)";
// On desktop the text column occupies the left 40% of the viewport, so the
// model should be horizontally centered in the middle of the remaining right
// 60% — i.e. at 40% + 60%/2 = 70% of viewport width instead of the default 50%.
const DESKTOP_MODEL_CENTER_FRACTION = 0.7;
// Scroll progress at/above which the model eases back to screen center for
// the final CTA section (whose text is centered too, not left-column).
const RECENTER_THRESHOLD = 0.85;
// Once recentered, the model must stay within this fraction of the viewport
// height (measured from the top) so it doesn't extend behind the CTA button
// row pinned to the bottom of the final section. Mobile stacks all three
// buttons into one taller column — a fixed rem-based height that eats a much
// bigger share of a typical phone's shorter viewport than the single-row
// desktop layout does — so it needs a tighter fit than desktop's ~75%.
const RECENTER_VERTICAL_FIT_DESKTOP = 0.75;
const RECENTER_VERTICAL_FIT_MOBILE = 0.65;
// Pose fractions for the inspect-mode panel buttons, expressed as positions
// in the combined ~110-frame Blender timeline (cover opens ~1-30, pause,
// first page flips ~40-70, pause, everything closes ~80-110): frame 30 is
// the cover fully open, frame 70 is the first page fully flipped. Closed
// (action time 0) has no panel button of its own — it's the entry default
// and the forced target during exit (see setInspectMode/finishInspectExit).
const POSE_CLOSED = 0;
const POSE_COVER_OPEN = 30 / 110;
const POSE_PAGE_FLIPPED = 70 / 110;
// How quickly the camera eases back to its pre-inspect pose on close (0-1/frame).
const CAMERA_RESET_LERP_FACTOR = 0.1;
// How long the inspect-mode controls-onboarding hint stays up before auto-fading.
const ONBOARDING_HINT_DURATION_MS = 4000;
// How close (as a fraction of maxDuration) the eased action time must get to
// POSE_CLOSED before an exit-in-progress is considered finished — see
// finishInspectExit().
const EXIT_CLOSE_EPSILON_FRACTION = 0.02;

// ---------- Module-level state ----------
let scene, camera, renderer;
let modelGroup;
let mixer;
let actions = []; // one clipAction per gltf.animations entry, all sharing one eased time
let maxDuration = 0; // longest clip duration — drives the scroll-to-time mapping
let easedActionTime = 0; // current eased value shared by every action.time
let easedOffsetX = 0; // current eased value of modelGroup.position.x
let easedOffsetY = 0; // current eased value of modelGroup's base y position (idle bob layers on top)
let scrollProgress = 0; // 0 at top of page, 1 at bottom
let controls;
let inspectMode = false; // true while OrbitControls/the inspect panel are active
let inspectExiting = false; // true during the brief "book closing" phase after Exit, before handoff to scroll
let initialCameraPosition, initialCameraQuaternion; // captured on entering inspect mode, restored on close
let inspectPoseTarget = 0; // action-time target driven by the Cover/Page 1 buttons while inspecting, or by the exit close
let onboardingTimeoutId = null; // pending auto-fade timer for the inspect-mode onboarding hint

const clock = new THREE.Clock();
const canvas = document.getElementById("scene-canvas");
const loadingIndicator = document.getElementById("loading-indicator");
const ctaActions = document.querySelector(".cta-actions");
const inspectPanel = document.getElementById("inspect-panel");
const inspectToggle = document.getElementById("inspect-toggle");
const inspectExitButton = document.getElementById("inspect-exit");
const inspectOnboarding = document.getElementById("inspect-onboarding");
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
// OrbitControls, created once and disabled by default — "Check Example
// Passport" toggles them on via setInspectMode().
function initControls() {
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enabled = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.panSpeed = 0.5;
  controls.enableZoom = true;

  // Placeholder distances until the model loads and loadPassportModel()
  // refines them against its actual bounding sphere.
  const distance = camera.position.length();
  controls.minDistance = distance * 0.5;
  controls.maxDistance = distance * 3;
}

// ---------- Model loading ----------
// World-space vertical extent visible in the camera frustum, at the fixed
// distance the camera and model sit at. Depends only on fov/distance (both
// constant — there's no camera movement or zoom in this app anymore), so
// it's resize-invariant and cheap enough to call every frame.
function getVisibleHeight() {
  const distance = camera.position.z;
  const fovRadians = THREE.MathUtils.degToRad(camera.fov);
  return 2 * Math.tan(fovRadians / 2) * distance;
}

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
  const scale = (getVisibleHeight() * FILL_RATIO) / maxDim;
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

      // Now that the model's real size is known, keep orbit zoom from going
      // inside the passport or drifting off to an unreadable distance.
      controls.minDistance = boundingRadius * 1.4;
      controls.maxDistance = boundingRadius * 6;

      // Seed the eased offsets at their correct starting values (matters if
      // the user has already scrolled past RECENTER_THRESHOLD by the time
      // the GLB finishes loading) so the model doesn't visibly slide in
      // from screen center/normal height on first load — animate() takes
      // over easing from here for every later change.
      easedOffsetX = getModelTargetOffsetX();
      easedOffsetY = getModelTargetOffsetY();
      modelGroup.position.x = easedOffsetX;
      modelGroup.position.y = easedOffsetY;

      // Drive every clip (cover-open, page-flip, close-all, ...) from the
      // same AnimationMixer and the same shared eased time value, so the
      // combined timeline advances as one continuous scroll-driven sequence.
      if (gltf.animations.length > 0) {
        mixer = new THREE.AnimationMixer(model);
        actions = gltf.animations.map((animClip) => {
          console.log(
            "Clip:", animClip.name,
            "duration:", animClip.duration.toFixed(2)
          );
          const clipAction = mixer.clipAction(animClip);
          clipAction.play();
          clipAction.paused = true; // scroll drives time — clips must not play on their own
          return clipAction;
        });
        maxDuration = Math.max(...gltf.animations.map((animClip) => animClip.duration));
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
      // TODO: end-of-page menu will be added here
    },
    { passive: true }
  );
}

// ---------- Inspect mode ----------
// "Check Example Passport" toggles free orbit/pan/zoom on the model via
// OrbitControls, replacing the CTA row with a small pose panel. Lesson from
// the previous inspect implementation: pointer events must actually reach
// the canvas — canvas.style.pointerEvents is toggled directly here (inline
// style beats the CSS default), and both the canvas and #inspect-panel are
// body-level siblings of <main>, so neither is caught by main's
// pointer-events: none cascade in the first place.
function onInspectKeydown(event) {
  if (event.key === "Escape") setInspectMode(false);
}

// Shown on every inspect activation (no persistence across sessions at this
// stage). Auto-fades after ONBOARDING_HINT_DURATION_MS, or earlier the
// moment the user actually drags or scrolls the canvas — either path runs
// through hideInspectOnboarding, which clears the timer and removes both
// listeners together so a stale timeout can't fire after the user has
// already left inspect mode (or dismissed the hint themselves).
function showInspectOnboarding() {
  if (!inspectOnboarding) return;
  inspectOnboarding.classList.add("is-visible");
  onboardingTimeoutId = setTimeout(hideInspectOnboarding, ONBOARDING_HINT_DURATION_MS);
  canvas.addEventListener("pointerdown", hideInspectOnboarding);
  canvas.addEventListener("wheel", hideInspectOnboarding);
}

function hideInspectOnboarding() {
  if (!inspectOnboarding) return;
  inspectOnboarding.classList.remove("is-visible");
  clearTimeout(onboardingTimeoutId);
  onboardingTimeoutId = null;
  canvas.removeEventListener("pointerdown", hideInspectOnboarding);
  canvas.removeEventListener("wheel", hideInspectOnboarding);
}

function setInspectMode(enabled) {
  if (enabled) {
    // Ignore re-activation while already inspecting, or while a previous
    // Exit is still mid-close (see finishInspectExit) — spamming Exit then
    // Check Example Passport must not overlap two state transitions.
    if (inspectMode || inspectExiting) return;
    inspectMode = true;

    // Stored fresh each time rather than once at init, per the requirement —
    // though since nothing else ever moves the camera outside inspect mode,
    // this is always (0, 0, 5)/identity in practice.
    initialCameraPosition = camera.position.clone();
    initialCameraQuaternion = camera.quaternion.clone();
    if (modelGroup) controls.target.copy(modelGroup.position);
    // Default to closed: activation happens at the page-bottom CTA section,
    // where scroll already dictates the closed pose, so this is little to
    // no visible movement rather than an unprompted auto-open.
    inspectPoseTarget = POSE_CLOSED * maxDuration;
    document.addEventListener("keydown", onInspectKeydown);
    showInspectOnboarding();

    controls.enabled = true;
    canvas.style.pointerEvents = "auto";
    // Locks page scroll while inspecting so it can't fight the orbit/pan/zoom
    // gestures, and so the scroll-driven animation can't move underneath it.
    document.body.style.overflow = "hidden";

    if (ctaActions) ctaActions.classList.add("is-hidden");
    if (inspectPanel) inspectPanel.classList.add("is-open");
    return;
  }

  if (!inspectMode) return; // already closed, or an exit is already in progress
  inspectMode = false;
  inspectExiting = true; // see finishInspectExit() — scroll-driven targeting waits for the book to actually close

  document.removeEventListener("keydown", onInspectKeydown);
  hideInspectOnboarding();

  // Exit always closes the book first, regardless of which pose it was left
  // in — see finishInspectExit() for why this can't just hand off to
  // scroll-driven targeting immediately.
  inspectPoseTarget = POSE_CLOSED * maxDuration;
  if (actions.length === 0) finishInspectExit(); // nothing to ease — finish immediately instead of hanging forever

  controls.enabled = false;
  canvas.style.pointerEvents = "none";
  // Scroll stays locked until finishInspectExit() completes the handoff —
  // see there for why (scrollProgress must not drift mid-transition).

  if (ctaActions) ctaActions.classList.remove("is-hidden");
  if (inspectPanel) inspectPanel.classList.remove("is-open");

  if (inspectToggle) inspectToggle.focus();
}

// Ends an in-progress exit once the book has visibly finished easing to
// POSE_CLOSED. Called from animate() each frame while inspectExiting is
// true, as soon as the eased action time is within EXIT_CLOSE_EPSILON_FRACTION
// of that target (or immediately, if there was never anything to ease).
//
// Root cause this works around: the clip's timeline is closed at BOTH ends —
// action time 0 (before the cover has opened) and action time maxDuration
// (after everything has closed again) render the identical pose despite
// being numerically far apart. Handing control back to scroll-driven
// targeting too early would set the target to ~maxDuration while the eased
// value was still near 0 (or wherever the inspected pose left it), and a
// plain per-frame lerp between those two numbers necessarily travels through
// every open/flip frame in between — the visible re-open/re-close replay
// this whole function exists to prevent. Snapping (not lerping) straight to
// the scroll-driven target here is safe specifically because both ends of
// the clip look the same: the jump is numerically large but visually zero.
// Scroll was kept locked for the whole exit so scrollProgress can't have
// drifted to something else in the meantime.
function finishInspectExit() {
  inspectExiting = false;
  easedActionTime = scrollProgress * maxDuration;
  document.body.style.overflow = "";
}

function initInspectUI() {
  if (inspectToggle) {
    inspectToggle.addEventListener("click", () => setInspectMode(true));
  }
  if (inspectExitButton) {
    inspectExitButton.addEventListener("click", () => setInspectMode(false));
  }

  const posesByKey = {
    cover: POSE_COVER_OPEN,
    page1: POSE_PAGE_FLIPPED,
  };

  document.querySelectorAll("[data-pose]").forEach((button) => {
    button.addEventListener("click", () => {
      inspectPoseTarget = posesByKey[button.dataset.pose] * maxDuration;
    });
  });
}

// ---------- Render loop ----------
function animate() {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();

  if (modelGroup) {
    // Subtle idle motion, small enough to stay out of the way of the
    // scroll-driven animation clips (which live on the mixer, not on this
    // group's transform).
    modelGroup.rotation.y =
      BASE_ROTATION_Y + Math.sin(elapsed * 0.4) * THREE.MathUtils.degToRad(3);

    // Ease the desktop column offset — and the page-end recenter back to
    // screen center — instead of snapping, reusing the same lerp pattern
    // as the animation scrubbing below.
    easedOffsetX = THREE.MathUtils.lerp(
      easedOffsetX,
      getModelTargetOffsetX(),
      SCRUB_LERP_FACTOR
    );
    modelGroup.position.x = easedOffsetX;

    // Same pattern for the vertical nudge that keeps the recentered model
    // clear of the CTA button row; the idle bob layers on top of it.
    easedOffsetY = THREE.MathUtils.lerp(
      easedOffsetY,
      getModelTargetOffsetY(),
      SCRUB_LERP_FACTOR
    );
    modelGroup.position.y = easedOffsetY + Math.sin(elapsed * 0.6) * 0.03;
  }

  if (actions.length > 0) {
    // One eased time value shared by every clip, so the cover-open,
    // page-flip, and close-all clips all advance together as a single
    // sequence. Normally scroll-driven; while inspecting OR mid-exit, the
    // target is forced instead (pose buttons, or POSE_CLOSED while exiting)
    // so scroll-driven targeting never inserts an intermediate non-zero
    // target during the handoff — see finishInspectExit() for why that
    // matters. Each clip's own time is clamped to its own duration in case
    // clips don't all run exactly maxDuration long.
    const targetActionTime =
      inspectMode || inspectExiting
        ? inspectPoseTarget
        : scrollProgress * maxDuration;
    easedActionTime = THREE.MathUtils.lerp(
      easedActionTime,
      targetActionTime,
      SCRUB_LERP_FACTOR
    );

    if (
      inspectExiting &&
      Math.abs(easedActionTime - inspectPoseTarget) <
        maxDuration * EXIT_CLOSE_EPSILON_FRACTION
    ) {
      finishInspectExit();
    }

    for (const clipAction of actions) {
      clipAction.time = THREE.MathUtils.clamp(
        easedActionTime,
        0,
        clipAction.getClip().duration
      );
    }
    mixer.update(0);
  }

  if (inspectMode) {
    controls.update();
  } else if (initialCameraPosition) {
    // Ease the camera back to its pre-inspect pose after closing, instead of
    // snapping. Only reachable from the `!inspectMode` branch, so it can
    // never run while inspection is active and fight OrbitControls. Guarded
    // on initialCameraPosition since it's undefined until inspect mode has
    // been entered at least once — before that the camera is already at rest.
    camera.position.lerp(initialCameraPosition, CAMERA_RESET_LERP_FACTOR);
    camera.quaternion.slerp(initialCameraQuaternion, CAMERA_RESET_LERP_FACTOR);
  }

  renderer.render(scene, camera);
}

// ---------- Responsive model layout ----------
// World-space X offset the model eases toward: 0 (screen center) once
// scroll progress reaches the page-end CTA section OR below the desktop
// breakpoint (mobile is already centered), otherwise the middle of the
// desktop text-free column. Computed from the camera's frustum width at
// the model's viewing distance rather than a hardcoded pixel/world value,
// so it's correct at any viewport size or aspect ratio, and it's simply
// re-read every frame in animate() rather than recomputed on specific
// events — so resizes and breakpoint changes ease smoothly too.
function getModelTargetOffsetX() {
  if (scrollProgress >= RECENTER_THRESHOLD) return 0;
  if (!desktopMediaQuery.matches) return 0;

  const visibleWidth = getVisibleHeight() * camera.aspect;
  const shiftFraction = DESKTOP_MODEL_CENTER_FRACTION - 0.5;
  return shiftFraction * visibleWidth;
}

// World-space Y the model's center eases toward once scroll reaches
// RECENTER_THRESHOLD, so its bottom edge stops at RECENTER_VERTICAL_FIT of
// the viewport height instead of drifting down into the button row pinned
// below it. The model's actual on-screen height is FILL_RATIO of the
// visible frustum height by construction (see frameModel/getVisibleHeight)
// — reusing that known relationship instead of re-measuring the live
// bounding box every frame. Clamped at 0 so this only ever nudges the
// model up, never below its normal centered position.
function getModelTargetOffsetY() {
  if (scrollProgress < RECENTER_THRESHOLD) return 0;

  const verticalFit = desktopMediaQuery.matches
    ? RECENTER_VERTICAL_FIT_DESKTOP
    : RECENTER_VERTICAL_FIT_MOBILE;

  const visibleHeight = getVisibleHeight();
  const modelWorldHeight = FILL_RATIO * visibleHeight;
  const fitBoundaryY = visibleHeight * (0.5 - verticalFit);

  return Math.max(0, fitBoundaryY + modelWorldHeight / 2);
}

// ---------- Resize handling ----------
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

// ---------- Init ----------
function init() {
  initScene();
  initLights();
  initControls();
  initScrollTracking();
  initInspectUI();
  loadPassportModel();
  window.addEventListener("resize", onResize);
  animate();
}

init();
