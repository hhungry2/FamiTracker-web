// Dn-FamiTracker web port - what a finger does on the pattern and on the frame list, which take
// touches themselves (touch-action: none) so that a drag can be either a scroll or a selection:
//
//   a tap                         as a click: the cursor goes there
//   two taps                      as a double click
//   a drag                        scrolls (the pattern: along the axis it began on), and goes on
//                                 for a while when the finger is flung
//   a long press, then a drag     selects, as a drag of the mouse does (in the pattern, inside the
//                                 selection, moves it)
//   a long press, then let go     the right button's menu
//
// TouchTracker decides, from points and times only (test/ui.mjs checks it); TouchGestures follows
// one finger on an element and tells its owner what it did. Mouse and pen are left to the owner.
//
//   const gestures = new TouchGestures(element, {tap, doubleTap, scroll, held, dragStart, dragMove,
//     dragEnd, menu, cancel}, {axisLock: true});

export const TOUCH = {
  SLOP: 8,               // pixels a finger may wander before a press is a drag
  LONG_PRESS: 450,       // milliseconds a press stays put to be a long press
  DOUBLE_TAP: 300,       // milliseconds between the taps of a double tap,
  DOUBLE_TAP_SLOP: 24,   // and how far apart they may be
  VELOCITY_WINDOW: 100,  // milliseconds of the moves the speed at the lift is taken from
  FLING_MIN: 0.3,        // pixels a millisecond a scroll must still go at, as the finger lifts, to fling
  FLING_STOP: 0.02,      // and a fling stops below this
  FLING_DECAY: 0.95,     // what a fling keeps of its speed every 16 ms
};

// One finger from where it pressed. Its phase goes press → scroll (it moved), or press → held (it
// stayed put until the long press) → drag (and then moved).
export class TouchTracker {
  // axisLock: a scroll stays on the axis it began on
  constructor(x, y, t, { axisLock = false } = {}) {
    this.phase = 'press';
    this.x0 = x;
    this.y0 = y;
    this.x = x;
    this.y = y;
    this.axisLock = axisLock;
    this.axis = null;
    this.samples = [{ t, x, y }];
  }

  // The finger at (x, y) at time t: {scroll: {dx, dy}} (by how much), {drag: 'start'} as a drag
  // after a long press begins, {drag: 'move'} as it goes on, or null
  move(x, y, t) {
    const dx = x - this.x, dy = y - this.y;
    this.x = x;
    this.y = y;
    this.samples.push({ t, x, y });
    while (this.samples.length > 2 && t - this.samples[1].t > TOUCH.VELOCITY_WINDOW)
      this.samples.shift();
    const far = Math.hypot(x - this.x0, y - this.y0) > TOUCH.SLOP;
    switch (this.phase) {
      case 'press':
        if (!far)
          return null;
        this.phase = 'scroll';
        if (this.axisLock)
          this.axis = Math.abs(x - this.x0) > Math.abs(y - this.y0) ? 'x' : 'y';
        // the scroll takes the whole way from the press, so that nothing of it is lost
        return { scroll: this.along(x - this.x0, y - this.y0) };
      case 'scroll':
        return { scroll: this.along(dx, dy) };
      case 'held':
        if (!far)
          return null;
        this.phase = 'drag';
        return { drag: 'start' };
      case 'drag':
        return { drag: 'move' };
    }
    return null;
  }

  along(dx, dy) {
    return { dx: this.axis === 'y' ? 0 : dx, dy: this.axis === 'x' ? 0 : dy };
  }

  // The long press's time has come: true when the finger has stayed put, which makes it held
  longPress() {
    if (this.phase !== 'press')
      return false;
    this.phase = 'held';
    return true;
  }

  // The finger lifts at time t: {tap}, {menu} (held, and let go where it was), {dragEnd},
  // {fling: {vx, vy}} (pixels a millisecond) or {scrollEnd}
  end(t) {
    switch (this.phase) {
      case 'press':
        return { tap: true };
      case 'held':
        return { menu: true };
      case 'drag':
        return { dragEnd: true };
    }
    // the speed of the last moves; a finger that rested before it lifted does not fling
    const last = this.samples.at(-1);
    const first = this.samples.find(s => t - s.t <= TOUCH.VELOCITY_WINDOW);
    if (!first || first === last || t - last.t > TOUCH.VELOCITY_WINDOW / 2)
      return { scrollEnd: true };
    const span = Math.max(1, t - first.t);
    const v = this.along((last.x - first.x) / span, (last.y - first.y) / span);
    return Math.hypot(v.dx, v.dy) >= TOUCH.FLING_MIN ? { fling: { vx: v.dx, vy: v.dy } } : { scrollEnd: true };
  }
}

// How far a fling goes on in the next `dt` milliseconds from speed (vx, vy), and the speed after
// them: {dx, dy, vx, vy, done}
export function flingStep(vx, vy, dt) {
  const keep = TOUCH.FLING_DECAY ** (dt / 16);
  const next = { vx: vx * keep, vy: vy * keep };
  return { dx: vx * dt, dy: vy * dt, ...next, done: Math.hypot(next.vx, next.vy) < TOUCH.FLING_STOP };
}

// Whether two taps make a double tap
export const isDoubleTap = (a, b) => !!a && !!b && b.t - a.t <= TOUCH.DOUBLE_TAP &&
  Math.hypot(b.x - a.x, b.y - a.y) <= TOUCH.DOUBLE_TAP_SLOP;

export class TouchGestures {
  // `handlers`, each optional, with client coordinates: tap(x, y), doubleTap(x, y), scroll(dx, dy)
  // (from the finger, and from a fling: false stops it), held(x, y), dragStart(x0, y0, x, y),
  // dragMove(x, y), dragEnd(x, y), menu(x, y), cancel()
  constructor(element, handlers, { axisLock = false } = {}) {
    this.element = element;
    this.handlers = handlers;
    this.axisLock = axisLock;
    this.tracker = null;
    this.pointerId = null;
    this.timer = null;
    this.lastTap = null;
    this.fling = null;
    this.lastTouch = -Infinity;
    element.addEventListener('pointerdown', e => this.onDown(e));
    element.addEventListener('pointermove', e => this.onMove(e));
    element.addEventListener('pointerup', e => this.onUp(e));
    element.addEventListener('pointercancel', e => this.onCancel(e));
    // a long press of a touch screen opens the browser's own menu (Android), and two taps may
    // make a double click: here these come from the gestures instead
    element.addEventListener('contextmenu', e => {
      if (this.fromTouch())
        e.preventDefault();
    }, { capture: true });
  }

  // Whether the event that comes now (a contextmenu, a dblclick) belongs to a finger
  fromTouch() {
    return this.tracker !== null || performance.now() - this.lastTouch < 800;
  }

  call(name, ...args) {
    return this.handlers[name]?.(...args);
  }

  onDown(e) {
    if (e.pointerType !== 'touch')
      return;
    this.lastTouch = performance.now();
    // one finger at a time
    if (this.tracker)
      return;
    e.preventDefault();
    this.stopFling();
    this.pointerId = e.pointerId;
    this.tracker = new TouchTracker(e.clientX, e.clientY, e.timeStamp, { axisLock: this.axisLock });
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.tracker?.longPress()) {
        // a buzz, where the browser lets a page have one (after a first tap)
        if (navigator.userActivation?.hasBeenActive ?? true)
          navigator.vibrate?.(10);
        this.call('held', this.tracker.x0, this.tracker.y0);
      }
    }, TOUCH.LONG_PRESS);
    try {
      this.element.setPointerCapture(e.pointerId);
    } catch {
      // a pointer of a test, which the browser does not know
    }
  }

  onMove(e) {
    if (e.pointerId !== this.pointerId || !this.tracker)
      return;
    this.lastTouch = performance.now();
    e.preventDefault();
    const tracker = this.tracker;
    const result = tracker.move(e.clientX, e.clientY, e.timeStamp);
    if (!result)
      return;
    this.clearTimer();
    if (result.scroll)
      this.call('scroll', result.scroll.dx, result.scroll.dy);
    else if (result.drag === 'start')
      this.call('dragStart', tracker.x0, tracker.y0, e.clientX, e.clientY);
    else
      this.call('dragMove', e.clientX, e.clientY);
  }

  onUp(e) {
    if (e.pointerId !== this.pointerId || !this.tracker)
      return;
    this.lastTouch = performance.now();
    const tracker = this.tracker;
    this.release();
    const result = tracker.end(e.timeStamp);
    if (result.tap) {
      const tap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      if (isDoubleTap(this.lastTap, tap)) {
        this.lastTap = null;
        this.call('doubleTap', this.lastTapAt?.x ?? tap.x, this.lastTapAt?.y ?? tap.y);
      } else {
        this.lastTap = tap;
        this.lastTapAt = tap;
        this.call('tap', tap.x, tap.y);
      }
    } else if (result.menu) {
      this.call('menu', tracker.x0, tracker.y0);
    } else if (result.dragEnd) {
      this.call('dragEnd', e.clientX, e.clientY);
    } else if (result.fling) {
      this.startFling(result.fling.vx, result.fling.vy);
    }
  }

  onCancel(e) {
    if (e.pointerId !== this.pointerId || !this.tracker)
      return;
    this.release();
    this.call('cancel');
  }

  release() {
    this.clearTimer();
    this.tracker = null;
    this.pointerId = null;
  }

  clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // The scroll goes on after the finger lifts, slower and slower; a scroll handler that returns
  // false (the end of what there is to scroll) stops it, and so does the next touch
  startFling(vx, vy) {
    let last = performance.now();
    const fling = { vx, vy };
    this.fling = fling;
    const frame = now => {
      if (this.fling !== fling)
        return;
      const step = flingStep(fling.vx, fling.vy, Math.min(50, now - last));
      last = now;
      Object.assign(fling, { vx: step.vx, vy: step.vy });
      if (this.call('scroll', step.dx, step.dy) === false || step.done) {
        this.fling = null;
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  stopFling() {
    this.fling = null;
  }
}
