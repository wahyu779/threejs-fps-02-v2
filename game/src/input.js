// input.js — keyboard + mouse.
// One job: turn browser events into one plain state object the player
// module reads every fixed step. Pointer lock is requested on canvas click.
export function makeInput(canvas) {
  const state = {
    keys: Object.create(null),
    mouseDX: 0, mouseDY: 0,
    mouseDown: false, mouseDownEdge: false,
    mouseRightDown: false, // ADS (right button) — read by player.js setZoom
    locked: false,
    pressed: Object.create(null), // one-frame edge triggers, cleared by endFrame
  };
  window.addEventListener('keydown', (e) => {
    if (!state.keys[e.code]) state.pressed[e.code] = true;
    state.keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { state.keys[e.code] = false; });
  window.addEventListener('blur', () => { state.keys = Object.create(null); state.mouseDown = false; state.mouseRightDown = false; });
  canvas.addEventListener('click', () => {
    if (!state.locked && canvas.requestPointerLock) canvas.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === canvas;
  });
  document.addEventListener('mousemove', (e) => {
    if (!state.locked) return;
    state.mouseDX += e.movementX || 0;
    state.mouseDY += e.movementY || 0;
  });
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) { state.mouseDown = true; state.mouseDownEdge = true; }
    if (e.button === 2) state.mouseRightDown = true;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // no menu on ADS click
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) state.mouseDown = false;
    if (e.button === 2) state.mouseRightDown = false;
  });
  state.endFrame = () => {
    state.mouseDX = 0; state.mouseDY = 0;
    state.mouseDownEdge = false;
    state.pressed = Object.create(null);
  };
  state.down = (code) => !!state.keys[code];
  state.hit = (code) => !!state.pressed[code];
  return state;
}
