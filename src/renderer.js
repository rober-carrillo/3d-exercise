/**
 * WebGL renderer: terrain, route ribbon, markers, and the camera.
 *
 * Two camera modes share one orbit rig:
 *   free  — you drive it (drag / wheel / pan)
 *   chase — it rides behind the cursor point, swinging to face the direction of
 *           travel, so replaying the route looks like a third-person follow cam.
 *           Dragging still works while chasing: it offsets your angle relative
 *           to the runner's heading instead of taking the camera off the rails.
 */

const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const SKY = [0.043, 0.063, 0.086];
/** shortest signed angular difference, so the camera never spins the long way */
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
/** frame-rate independent easing */
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

const mat4 = () => new Float32Array(16);
function perspective(o, fovy, asp, n, f) {
  const t = 1 / Math.tan(fovy / 2);
  o.fill(0); o[0] = t / asp; o[5] = t; o[11] = -1; o[10] = (f + n) / (n - f); o[14] = 2 * f * n / (n - f);
  return o;
}
function lookAt(o, e, c, u) {
  let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0; o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
  o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
  o[12] = -(xx * e[0] + xy * e[1] + xz * e[2]);
  o[13] = -(yx * e[0] + yy * e[1] + yz * e[2]);
  o[14] = -(zx * e[0] + zy * e[1] + zz * e[2]); o[15] = 1;
  return o;
}
function mul(o, a, b) {
  for (let i = 0; i < 4; i++) {
    const a0 = a[i], a1 = a[i + 4], a2 = a[i + 8], a3 = a[i + 12];
    for (let j = 0; j < 4; j++) o[i + j * 4] = a0 * b[j * 4] + a1 * b[j * 4 + 1] + a2 * b[j * 4 + 2] + a3 * b[j * 4 + 3];
  }
  return o;
}

const RAMP_GLSL = `
vec3 ramp(float t){t=clamp(t,0.0,1.0);
  vec3 c0=vec3(0.133,0.827,0.933),c1=vec3(0.639,0.902,0.208),c2=vec3(0.984,0.749,0.141),c3=vec3(0.957,0.247,0.369);
  if(t<0.35)return mix(c0,c1,t/0.35);
  if(t<0.70)return mix(c1,c2,(t-0.35)/0.35);
  return mix(c2,c3,(t-0.70)/0.30);}`;
const FOG_GLSL = `float fogf(float d){return smoothstep(uFogNear,uFogFar,d);}`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false })
            || canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL is not available in this browser');
    this.gl = gl;
    const gl2 = !!(window.WebGL2RenderingContext && gl instanceof WebGL2RenderingContext);
    this.caps = { gl2, uint: gl2 || !!gl.getExtension('OES_element_index_uint') };

    this.state = { vex: 1.8, texture: true, curtain: true, chase: false };
    this.cam = { az: -2.24, pol: 0.97, dist: 1, tx: 0, ty: 0, tz: 0 };
    this.home = { az: -2.24, pol: 0.97, distScale: 1.45, bearing: 0, lift: 0.09 };
    this.chase = { dist: 0, pol: 1.10, azOffset: 0, height: 0 };
    this.cursor = 0;
    this.hasTexture = false;
    this.onFrame = null;
    this._P = mat4(); this._V = mat4(); this._MVP = mat4();
    this._buffers = {};
    this._buildPrograms();
    this._bindInput();
  }

  _shader(type, src) {
    const gl = this.gl, s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  _program(vs, fs) {
    const gl = this.gl, p = gl.createProgram();
    gl.attachShader(p, this._shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this._shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    p.u = new Proxy({}, { get: (t, k) => (t[k] !== undefined ? t[k] : (t[k] = gl.getUniformLocation(p, k))) });
    p.a = n => gl.getAttribLocation(p, n);
    return p;
  }
  _buildPrograms() {
    this.pTer = this._program(`
attribute vec3 aPos;attribute vec2 aSlope;attribute vec2 aUv;
uniform mat4 uMVP;uniform float uVex;uniform vec3 uCam;
varying vec2 vUv;varying vec3 vN;varying float vH;varying float vD;
void main(){vec3 p=vec3(aPos.xy,aPos.z*uVex);
  vN=normalize(vec3(-aSlope.x*uVex,-aSlope.y*uVex,1.0));vH=aPos.z;vUv=aUv;vD=distance(p,uCam);
  gl_Position=uMVP*vec4(p,1.0);}`, `
precision highp float;
uniform sampler2D uTex;uniform float uHasTex,uHSpan,uFogNear,uFogFar;uniform vec3 uLight,uSky;
varying vec2 vUv;varying vec3 vN;varying float vH;varying float vD;
${RAMP_GLSL}${FOG_GLSL}
void main(){vec3 n=normalize(vN);
  vec3 base=uHasTex>0.5?texture2D(uTex,vUv).rgb:(ramp(clamp(vH/uHSpan,0.0,1.0))*0.42+0.10);
  float lam=max(dot(n,uLight),0.0);float sky=0.5+0.5*n.z;
  vec3 col=base*(0.34+0.78*lam)+base*sky*0.16;
  col+=vec3(0.03,0.05,0.09)*(1.0-lam)*sky;
  gl_FragColor=vec4(mix(col,uSky,fogf(vD)*0.88),1.0);}`);

    this.pCol = this._program(`
attribute vec3 aPos;attribute vec4 aCol;
uniform mat4 uMVP;uniform float uVex,uPointSize;uniform vec3 uCam;
varying vec4 vCol;varying float vD;
void main(){vec3 p=vec3(aPos.xy,aPos.z*uVex);vCol=aCol;vD=distance(p,uCam);
  gl_Position=uMVP*vec4(p,1.0);gl_PointSize=uPointSize;}`, `
precision highp float;
uniform float uIsPoint,uFogNear,uFogFar;uniform vec3 uSky;
varying vec4 vCol;varying float vD;
${FOG_GLSL}
void main(){vec4 c=vCol;
  if(uIsPoint>0.5){vec2 d=gl_PointCoord-0.5;float r=length(d);if(r>0.5)discard;
    c.rgb=mix(vec3(1.0),c.rgb,smoothstep(0.20,0.34,r));c.a*=smoothstep(0.50,0.43,r);}
  gl_FragColor=vec4(mix(c.rgb,uSky,fogf(vD)*0.6),c.a);}`);
  }

  _buf(data, target) {
    const gl = this.gl, b = gl.createBuffer(), t = target || gl.ARRAY_BUFFER;
    gl.bindBuffer(t, b); gl.bufferData(t, data, gl.STATIC_DRAW);
    return b;
  }
  _attr(p, name, b, size) {
    const gl = this.gl, l = p.a(name);
    if (l < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.enableVertexAttribArray(l);
    gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0);
  }

  setGeometry(g) {
    const gl = this.gl;
    this.g = g;
    const B = this._buffers;
    B.ter = {
      pos: this._buf(g.terrain.pos), slope: this._buf(g.terrain.slope), uv: this._buf(g.terrain.uv),
      idx: this._buf(g.terrain.idx, gl.ELEMENT_ARRAY_BUFFER), n: g.terrain.idx.length,
      type: g.indexType === 'uint32' ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
    };
    B.skirt = { pos: this._buf(g.skirt.pos), col: this._buf(g.skirt.col), n: g.skirt.pos.length / 3 };
    B.rib = { pos: this._buf(g.ribbon.pos), col: this._buf(g.ribbon.col), n: g.track.n * 2 };
    B.out = { pos: this._buf(g.outline.pos), col: this._buf(g.outline.col), n: g.track.n * 2 };
    B.wall = { pos: this._buf(g.curtain.pos), col: this._buf(g.curtain.col), n: g.track.n * 2 };
    B.mk = {
      pos: gl.createBuffer(),
      col: this._buf(new Float32Array([0.62, 0.90, 0.20, 1, 0.96, 0.25, 0.37, 1, 1, 1, 1, 1])),
    };
    B.arrow = {
      pos: gl.createBuffer(),
      col: this._buf(new Float32Array([1, 1, 1, 1, 0.55, 0.93, 1, 1, 0.55, 0.93, 1, 1])),
    };
    // face the route the way it runs: start near the camera, finish away from it
    this.home.bearing = g.track.bearing;
    this.home.az = g.track.bearing + Math.PI;
    this.cam.dist = g.ext * this.home.distScale;
    this.chase.dist = g.ext * 0.13;
    this.chase.height = g.hSpan * 0.02;
    this.cam.tz = (this.g.track.tz[0] || 0);
    this.resetView();
    this.setCursor(0);
  }

  setTexture(source) {
    const gl = this.gl;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.hasTexture = true;
  }

  /** Move the "you are here" point; drives both the markers and the chase cam. */
  setCursor(i) {
    if (!this.g) return;
    const gl = this.gl, t = this.g.track, B = this._buffers;
    this.cursor = i = clamp(i | 0, 0, t.n - 1);
    const lift = Math.max(10, this.g.hSpan * 0.02);
    gl.bindBuffer(gl.ARRAY_BUFFER, B.mk.pos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      t.tx[0], t.ty[0], t.tz[0] + lift,
      t.tx[t.n - 1], t.ty[t.n - 1], t.tz[t.n - 1] + lift,
      t.tx[i], t.ty[i], t.tz[i] + lift,
    ]), gl.DYNAMIC_DRAW);

    // a flat chevron on the surface showing which way the runner is facing
    const h = t.head[i], f = [Math.cos(h), Math.sin(h)], r = [Math.sin(h), -Math.cos(h)];
    const L = t.width * 3.4, Wd = t.width * 1.5, z = t.tz[i] + lift * 0.35;
    gl.bindBuffer(gl.ARRAY_BUFFER, B.arrow.pos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      t.tx[i] + f[0] * L, t.ty[i] + f[1] * L, z,
      t.tx[i] - f[0] * L * 0.5 + r[0] * Wd, t.ty[i] - f[1] * L * 0.5 + r[1] * Wd, z,
      t.tx[i] - f[0] * L * 0.5 - r[0] * Wd, t.ty[i] - f[1] * L * 0.5 - r[1] * Wd, z,
    ]), gl.DYNAMIC_DRAW);
  }

  /**
   * Swing in directly behind the cursor point, aimed down the route: the point
   * sits just in front of you and the track ahead recedes up the screen.
   */
  beginChase() {
    this.state.chase = true;
    this.chase.azOffset = 0;
    this.chase.pol = 1.10;
    if (this.g) this.chase.dist = this.g.ext * 0.13;
  }

  resetView() {
    this.cam.az = this.home.az; this.cam.pol = this.home.pol;
    // pull the look-at point back along the route so the whole track lifts clear
    // of the elevation-profile panel instead of running off the bottom edge
    const off = this.g ? this.g.ext * this.home.lift : 0;
    this.cam.tx = -Math.cos(this.home.bearing) * off;
    this.cam.ty = -Math.sin(this.home.bearing) * off;
    this.chase.azOffset = 0; this.chase.pol = 1.10;
    if (this.g) {
      this.cam.dist = this.g.ext * this.home.distScale;
      this.chase.dist = this.g.ext * 0.13;
      this.cam.tz = this.g.hSpan * 0.5;
    }
  }

  _eye() {
    const { cam } = this, tz = cam.tz * this.state.vex;
    return [
      cam.tx + cam.dist * Math.sin(cam.pol) * Math.cos(cam.az),
      cam.ty + cam.dist * Math.sin(cam.pol) * Math.sin(cam.az),
      tz + cam.dist * Math.cos(cam.pol),
    ];
  }

  _bindInput() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId); c.classList.add('dragging');
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
    });
    c.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (this.state.chase) {                       // look around the runner
        this.chase.azOffset = wrap(this.chase.azOffset - dx * 0.005);
        this.chase.pol = clamp(this.chase.pol - dy * 0.005, 0.25, 1.48);
      } else if (drag.pan) {
        const s = this.cam.dist * 0.0016;
        this.cam.tx += (Math.sin(this.cam.az) * dx + Math.cos(this.cam.az) * dy) * s;
        this.cam.ty += (-Math.cos(this.cam.az) * dx + Math.sin(this.cam.az) * dy) * s;
      } else {
        this.cam.az -= dx * 0.005;
        this.cam.pol = clamp(this.cam.pol - dy * 0.005, 0.06, 1.52);
      }
    });
    const end = () => { drag = null; c.classList.remove('dragging'); };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const k = Math.exp(e.deltaY * 0.0012), ext = this.g ? this.g.ext : 1;
      if (this.state.chase) this.chase.dist = clamp(this.chase.dist * k, ext * 0.02, ext * 0.9);
      else this.cam.dist = clamp(this.cam.dist * k, ext * 0.06, ext * 3.2);
    }, { passive: false });
    let pinch = null;
    c.addEventListener('touchmove', e => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (pinch) {
          const ext = this.g ? this.g.ext : 1, k = pinch / d;
          if (this.state.chase) this.chase.dist = clamp(this.chase.dist * k, ext * 0.02, ext * 0.9);
          else this.cam.dist = clamp(this.cam.dist * k, ext * 0.06, ext * 3.2);
        }
        pinch = d;
      } else pinch = null;
    }, { passive: false });
    c.addEventListener('touchend', () => { pinch = null; });
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (w !== this.canvas.width || h !== this.canvas.height) { this.canvas.width = w; this.canvas.height = h; }
  }

  /** Ride behind the cursor point, facing the way it is travelling. */
  _updateChase(dt) {
    const t = this.g.track, i = this.cursor;
    const wantAz = wrap(t.course[i] + Math.PI + this.chase.azOffset);
    this.cam.az += wrap(wantAz - this.cam.az) * ease(2.6, dt);
    this.cam.pol += (this.chase.pol - this.cam.pol) * ease(2.2, dt);
    this.cam.dist += (this.chase.dist - this.cam.dist) * ease(2.2, dt);
    const k = ease(4.5, dt);
    this.cam.tx += (t.tx[i] - this.cam.tx) * k;
    this.cam.ty += (t.ty[i] - this.cam.ty) * k;
    this.cam.tz += (t.tz[i] + this.chase.height - this.cam.tz) * k;
  }

  start() {
    const gl = this.gl;
    let last = performance.now();
    const frame = now => {
      requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (this.onFrame) this.onFrame(dt);
      if (this.state.chase && this.g) this._updateChase(dt);
      this._resize();
      const W = this.canvas.width, H = this.canvas.height;
      gl.viewport(0, 0, W, H);
      gl.clearColor(SKY[0], SKY[1], SKY[2], 1);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!this.g) return;

      const eye = this._eye(), tgt = [this.cam.tx, this.cam.ty, this.cam.tz * this.state.vex];
      perspective(this._P, 45 * D2R, W / H, this.g.ext / 500, this.g.ext * 16);
      lookAt(this._V, eye, tgt, [0, 0, 1]);
      mul(this._MVP, this._P, this._V);
      // haze follows the camera distance, so zooming out never dims the scene
      const fogN = this.cam.dist * 0.95, fogF = this.cam.dist * 3.0;
      const useTex = this.hasTexture && this.state.texture ? 1 : 0;
      const B = this._buffers, pT = this.pTer, pC = this.pCol;

      gl.useProgram(pT);
      gl.uniformMatrix4fv(pT.u.uMVP, false, this._MVP);
      gl.uniform1f(pT.u.uVex, this.state.vex);
      gl.uniform3fv(pT.u.uCam, eye);
      gl.uniform1f(pT.u.uHasTex, useTex);
      gl.uniform1f(pT.u.uHSpan, this.g.hSpan);
      gl.uniform3fv(pT.u.uLight, new Float32Array([Math.cos(0.86) * Math.cos(0.62), Math.sin(0.86) * Math.cos(0.62), Math.sin(0.62)]));
      gl.uniform3fv(pT.u.uSky, new Float32Array(SKY));
      gl.uniform1f(pT.u.uFogNear, fogN); gl.uniform1f(pT.u.uFogFar, fogF);
      if (useTex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture); gl.uniform1i(pT.u.uTex, 0); }
      this._attr(pT, 'aPos', B.ter.pos, 3); this._attr(pT, 'aSlope', B.ter.slope, 2); this._attr(pT, 'aUv', B.ter.uv, 2);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, B.ter.idx);
      gl.drawElements(gl.TRIANGLES, B.ter.n, B.ter.type, 0);

      gl.useProgram(pC);
      gl.uniformMatrix4fv(pC.u.uMVP, false, this._MVP);
      gl.uniform1f(pC.u.uVex, this.state.vex);
      gl.uniform3fv(pC.u.uCam, eye);
      gl.uniform3fv(pC.u.uSky, new Float32Array(SKY));
      gl.uniform1f(pC.u.uFogNear, fogN); gl.uniform1f(pC.u.uFogFar, fogF);
      gl.uniform1f(pC.u.uIsPoint, 0); gl.uniform1f(pC.u.uPointSize, 1);
      gl.disable(gl.BLEND);
      this._attr(pC, 'aPos', B.skirt.pos, 3); this._attr(pC, 'aCol', B.skirt.col, 4);
      gl.drawArrays(gl.TRIANGLES, 0, B.skirt.n);

      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-2.0, -3);
      this._attr(pC, 'aPos', B.out.pos, 3); this._attr(pC, 'aCol', B.out.col, 4);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, B.out.n);
      gl.polygonOffset(-4.0, -8);
      this._attr(pC, 'aPos', B.rib.pos, 3); this._attr(pC, 'aCol', B.rib.col, 4);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, B.rib.n);
      gl.polygonOffset(-6.0, -12);
      this._attr(pC, 'aPos', B.arrow.pos, 3); this._attr(pC, 'aCol', B.arrow.col, 4);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.POLYGON_OFFSET_FILL);

      if (this.state.curtain) {
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
        this._attr(pC, 'aPos', B.wall.pos, 3); this._attr(pC, 'aCol', B.wall.col, 4);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, B.wall.n);
        gl.depthMask(true); gl.disable(gl.BLEND);
      }

      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(pC.u.uIsPoint, 1);
      gl.uniform1f(pC.u.uPointSize, Math.max(9, Math.min(20, H * 0.016)));
      this._attr(pC, 'aPos', B.mk.pos, 3); this._attr(pC, 'aCol', B.mk.col, 4);
      gl.drawArrays(gl.POINTS, 0, 3);
      gl.disable(gl.BLEND);
    };
    requestAnimationFrame(frame);
  }
}
