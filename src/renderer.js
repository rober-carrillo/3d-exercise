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
const lerp = (a, b, t) => a + (b - a) * t;
const SKY = [0.043, 0.063, 0.086];
/** shortest signed angular difference, so the camera never spins the long way */
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
/** frame-rate independent easing */
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

const FIG_MAX = 900;            // vertices in the walking figure (~160 triangles)
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

    this.state = { vex: 1, texture: true, curtain: true, chase: false };
    this.cam = { az: -2.24, pol: 0.97, dist: 1, tx: 0, ty: 0, tz: 0 };
    this.home = { az: -2.24, pol: 0.97, distScale: 1.45, bearing: 0, lift: 0.09 };
    this.chase = { dist: 0, pol: 1.10, azOffset: 0, height: 0 };
    this.cursor = 0;               // nearest sample index (array lookups)
    this.cursorF = 0;              // continuous position along the track
    this.faceAz = null;            // eased facing, so the figure never snaps
    this.hasTexture = false;
    this.walking = false;          // true while the route is replaying
    this.walkPhase = 0;
    this.walkRate = 1;             // follows the playback speed multiplier
    this.onFrame = null;
    this.onChaseRelease = null;    // fired when a drag frees the camera from chase
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
    B.fig = { pos: gl.createBuffer(), col: gl.createBuffer(), n: 0 };
    this._figPos = new Float32Array(FIG_MAX * 3);
    this._figCol = new Float32Array(FIG_MAX * 4);
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

  /**
   * Move the "you are here" position. Takes a *fractional* index: the track is
   * sampled about every 10 m, and at playback speed that is ~30 samples a
   * second, so stepping index by index makes the figure stutter. Everything
   * downstream interpolates between samples instead.
   */
  setCursor(f) {
    if (!this.g) return;
    const n = this.g.track.n;
    this.cursorF = clamp(+f || 0, 0, n - 1);
    this.cursor = clamp(Math.round(this.cursorF), 0, n - 1);
  }

  /** Interpolated position on the smoothed path. */
  _pos() {
    const t = this.g.track, f = this.cursorF;
    const i = Math.floor(f), j = Math.min(t.n - 1, i + 1), u = f - i;
    return [lerp(t.sx[i], t.sx[j], u), lerp(t.sy[i], t.sy[j], u), lerp(t.sz[i], t.sz[j], u)];
  }

  /** Facing the figure should turn towards, interpolated the short way round. */
  _facing() {
    const t = this.g.track, f = this.cursorF;
    const i = Math.floor(f), j = Math.min(t.n - 1, i + 1), u = f - i;
    return t.head[i] + wrap(t.head[j] - t.head[i]) * u;
  }

  figureSize() { return this.g ? Math.max(this.g.track.width * 2.1, this.g.ext * 0.008) : 1; }

  _updateMarkers() {
    const gl = this.gl, t = this.g.track, B = this._buffers;
    const lift = Math.max(10, this.g.hSpan * 0.02);
    // the cursor dot rides just above the walker's head, so the position still
    // reads when the figure itself is only a few pixels tall
    const overhead = this.figureSize() * 1.35 / Math.max(0.001, this.state.vex);
    const p = this._pos();
    gl.bindBuffer(gl.ARRAY_BUFFER, B.mk.pos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      t.tx[0], t.ty[0], t.tz[0] + lift,
      t.tx[t.n - 1], t.ty[t.n - 1], t.tz[t.n - 1] + lift,
      p[0], p[1], p[2] + overhead,
    ]), gl.DYNAMIC_DRAW);
  }

  /**
   * Rebuild the little walking figure — a low-poly take on the restroom-sign
   * woman — at the cursor point, facing along the track.
   *
   * It is rebuilt every frame rather than transformed on the GPU: it is ~70
   * triangles, which costs nothing, and it keeps the walk cycle, the terrain
   * snapping and the vertical-exaggeration compensation in one place. Heights
   * are divided by the exaggeration factor because the shader multiplies every
   * z by it — the ground gets stretched, the walker should not.
   */
  _buildFigure() {
    const S = this.figureSize(), vex = Math.max(0.001, this.state.vex);
    const h = this.faceAz === null ? this._facing() : this.faceAz;
    const ch = Math.cos(h), sh = Math.sin(h);
    const ph = this.walkPhase;
    const legA = Math.sin(ph) * 0.55, armA = Math.sin(ph + Math.PI) * 0.42;
    const bob = (Math.abs(Math.sin(ph)) - 0.5) * 0.025 * S;
    const p = this._pos(), ox = p[0], oy = p[1], oz = p[2];

    const P = this._figPos, C = this._figCol;
    let n = 0;
    const L = [Math.cos(0.86) * Math.cos(0.62), Math.sin(0.86) * Math.cos(0.62), Math.sin(0.62)];

    // local frame: x forward, y left, z up (metres)
    const rotXZ = (p, pz0, a) => {
      const dx = p[0], dz = p[2] - pz0, c = Math.cos(a), s = Math.sin(a);
      return [dx * c + dz * s, p[1], pz0 - dx * s + dz * c];
    };
    const push = (p, col, lam) => {
      P[n * 3] = ox + p[0] * ch - p[1] * sh;
      P[n * 3 + 1] = oy + p[0] * sh + p[1] * ch;
      P[n * 3 + 2] = oz + (p[2] + bob) / vex;
      const k = 0.56 + 0.58 * lam;
      C[n * 4] = col[0] * k; C[n * 4 + 1] = col[1] * k; C[n * 4 + 2] = col[2] * k; C[n * 4 + 3] = 1;
      n++;
    };
    const quad = (a, b, c, d, col, nrm) => {
      let nx, ny, nz;
      if (nrm) { [nx, ny, nz] = nrm; } else {
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        nx = u[1] * v[2] - u[2] * v[1]; ny = u[2] * v[0] - u[0] * v[2]; nz = u[0] * v[1] - u[1] * v[0];
      }
      const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
      const wx = nx * ch - ny * sh, wy = nx * sh + ny * ch;   // normal into world yaw
      const lam = Math.max(0, wx * L[0] + wy * L[1] + nz * L[2]);
      for (const p of [a, b, c, a, c, d]) push(p, col, lam);
    };
    // every part is an eight-corner solid; these two helpers just supply corners
    const poly8 = (cs, col, swing, pivot) => {
      const c = swing ? cs.map(p => rotXZ(p, pivot, swing)) : cs;
      quad(c[4], c[5], c[6], c[7], col);   // top
      quad(c[3], c[2], c[1], c[0], col);   // bottom
      quad(c[0], c[1], c[5], c[4], col);   // -y side
      quad(c[2], c[3], c[7], c[6], col);   // +y side
      quad(c[1], c[2], c[6], c[5], col);   // +x front
      quad(c[3], c[0], c[4], c[7], col);   // -x back
    };
    const block = (x0, x1, y0, y1, z0, z1, col, swing, pivot) => poly8([
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ], col, swing, pivot);
    /** a limb that leans sideways: y offset differs bottom (yb) to top (yt) */
    const limb = (x, yb, yt, w, z0, z1, col, swing, pivot) => poly8([
      [-x, yb - w, z0], [x, yb - w, z0], [x, yb + w, z0], [-x, yb + w, z0],
      [-x, yt - w, z1], [x, yt - w, z1], [x, yt + w, z1], [-x, yt + w, z1],
    ], col, swing, pivot);

    // an eight-corner tapered box — the dress needs a wide hem and narrow
    // shoulders, which a plain block cannot do
    const frustum = (yb, xb, z0, yt, xt, z1, col) => poly8([
      [-xb, -yb, z0], [xb, -yb, z0], [xb, yb, z0], [-xb, yb, z0],
      [-xt, -yt, z1], [xt, -yt, z1], [xt, yt, z1], [-xt, yt, z1],
    ], col, 0, 0);

    const body = [0.58, 0.34, 0.94], skin = [0.66, 0.44, 0.98];   // purple, head a shade lighter

    // legs, swinging from the hip
    const legW = 0.032 * S, hip = 0.36 * S;
    for (const side of [-1, 1]) {
      const y = side * 0.052 * S;
      block(-legW, legW, y - legW, y + legW, 0, hip, body, side > 0 ? legA : -legA, hip);
    }
    // arms, swinging opposite the legs and splayed outward the way the sign
    // figure holds them, so they stay clear of the dress
    const armW = 0.025 * S, shoulderZ = 0.68 * S;
    for (const side of [-1, 1]) {
      limb(armW, side * 0.166 * S, side * 0.108 * S, armW, 0.33 * S, shoulderZ, body,
        side > 0 ? armA : -armA, shoulderZ);
    }
    // the dress: the wide hem tapering to the shoulders is what makes the
    // pictogram read as the restroom-sign woman rather than a stick figure
    frustum(0.196 * S, 0.055 * S, 0.30 * S, 0.094 * S, 0.043 * S, 0.72 * S, body);
    // head: a low-poly sphere, normals taken from the face centre so the
    // faceting shades as a ball rather than as a bag of flat plates
    const hr = 0.088 * S, hz = 0.775 * S + hr, LON = 8, LAT = 6;
    const sp = (j, k) => {
      const phi = Math.PI * j / LAT, th = 2 * Math.PI * k / LON;
      return [hr * Math.sin(phi) * Math.cos(th), hr * Math.sin(phi) * Math.sin(th), hz + hr * Math.cos(phi)];
    };
    for (let j = 0; j < LAT; j++) for (let k = 0; k < LON; k++) {
      const a = sp(j, k), b = sp(j, k + 1), c = sp(j + 1, k + 1), d = sp(j + 1, k);
      const n = [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4,
                 (a[2] + b[2] + c[2] + d[2]) / 4 - hz];
      quad(a, b, c, d, skin, n);
    }

    const gl = this.gl, B = this._buffers;
    B.fig.n = n;
    gl.bindBuffer(gl.ARRAY_BUFFER, B.fig.pos);
    gl.bufferData(gl.ARRAY_BUFFER, P.subarray(0, n * 3), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, B.fig.col);
    gl.bufferData(gl.ARRAY_BUFFER, C.subarray(0, n * 4), gl.DYNAMIC_DRAW);
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
      // Dragging while the replay is paused releases the camera: chase stops
      // driving it and you orbit freely around wherever the figure is standing.
      // Because chase has been steering the same cam values all along, dropping
      // out of it leaves the camera exactly where it is — no jump. Fly route
      // puts it back behind her.
      if (this.state.chase && !this.walking) {
        this.state.chase = false;
        this.onChaseRelease && this.onChaseRelease();
      }
      if (this.state.chase) {                       // moving: look around the runner
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
    const t = this.g.track, i = this.cursor, p = this._pos();
    const wantAz = wrap(t.course[i] + Math.PI + this.chase.azOffset);
    this.cam.az += wrap(wantAz - this.cam.az) * ease(2.6, dt);
    this.cam.pol += (this.chase.pol - this.cam.pol) * ease(2.2, dt);
    this.cam.dist += (this.chase.dist - this.cam.dist) * ease(2.2, dt);
    const k = ease(4.5, dt);
    this.cam.tx += (p[0] - this.cam.tx) * k;
    this.cam.ty += (p[1] - this.cam.ty) * k;
    this.cam.tz += (p[2] + this.chase.height - this.cam.tz) * k;
  }

  start() {
    const gl = this.gl;
    let last = performance.now();
    const frame = now => {
      requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (this.onFrame) this.onFrame(dt);
      // the walk cycle only turns while the route is actually replaying
      if (this.walking) this.walkPhase += dt * 5.0 * this.walkRate;
      if (this.g) {
        // ease the facing rather than reading it raw: consecutive GPS bearings
        // disagree by a few degrees and snapping between them looks like a shiver
        const want = this._facing();
        this.faceAz = this.faceAz === null ? want : this.faceAz + wrap(want - this.faceAz) * ease(6, dt);
        this._updateMarkers();
      }
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
      gl.disable(gl.POLYGON_OFFSET_FILL);

      this._buildFigure();
      this._attr(pC, 'aPos', B.fig.pos, 3); this._attr(pC, 'aCol', B.fig.col, 4);
      gl.drawArrays(gl.TRIANGLES, 0, B.fig.n);

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
