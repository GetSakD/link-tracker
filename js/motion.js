/* How a train or bus moves on screen between data updates.

   Every vehicle rides along its real track or road shape ("s" metres along it). A model says where
   it should be right now (the target) and how fast that target moves. The Follower chases the
   target with a speed that changes gradually, so position AND velocity stay continuous — the thing
   Apple calls out as the key to motion that feels right. It never rolls backwards over small
   disagreements: if the vehicle is ahead of the data, it slows down and waits. Only a big
   disagreement (wrong stretch of track) is corrected backwards, smoothly. */
import { clamp, angleDiff } from './util.js';

export class Follower {
  constructor({ backTolerance = 150, maxSpeed = 30, catchUp = 6, accel = 1200 } = {}) {
    Object.assign(this, { backTolerance, maxSpeed, catchUp, accel });
    this.s = null; this.v = 0; this.heading = null;
  }
  reset(s, v = 0) { this.s = s; this.v = v; }
  /* target: metres along the shape now; speed: how fast the target moves (m/s); dt in ms */
  step(target, speed, dt) {
    if (this.s == null || Math.abs(target - this.s) > 3000) { this.reset(target, speed); return this.s; }
    const gap = target - this.s, k = Math.min(1, dt / this.accel);
    if (gap < -this.backTolerance) {            // badly ahead: ease back
      this.v = 0;
      this.s += gap * Math.min(1, dt / 1800);
      return this.s;
    }
    const want = gap < -2 ? 0 : clamp(speed + gap / this.catchUp, 0, Math.max(this.maxSpeed, speed));
    this.v += (want - this.v) * k;
    this.s += this.v * dt / 1000;
    return this.s;
  }
  /* turn toward a heading, quickly enough to follow the road but never snapping */
  turn(target, dt, ms = 220) {
    if (target == null) return this.heading;
    if (this.heading == null) this.heading = target;
    else this.heading = (this.heading + angleDiff(target, this.heading) * Math.min(1, dt / ms) + 360) % 360;
    return this.heading;
  }
}

/* For a vehicle we can't place on a shape: glide from where it is to the new fix. */
export class Glide {
  constructor(p, heading = 0) { this.from = this.to = this.cur = p; this.t0 = 0; this.dur = 1; this.h0 = this.h1 = this.heading = heading; }
  set(p, heading, t) {
    this.from = this.cur; this.to = p; this.t0 = t; this.dur = 2600;
    this.h0 = this.heading; this.h1 = heading ?? this.heading;
  }
  step(t) {
    let k = clamp((t - this.t0) / this.dur, 0, 1);
    k = k * k * (3 - 2 * k);
    this.cur = { lat: this.from.lat + (this.to.lat - this.from.lat) * k, lon: this.from.lon + (this.to.lon - this.from.lon) * k };
    this.heading = (this.h0 + angleDiff(this.h1, this.h0) * Math.min(1, k * 1.6) + 360) % 360;
    return k < 1;
  }
}
