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
/** The haze and clear colour come from the page's --sky token, so the scene follows light and dark mode. */
function readSky() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--sky').trim();
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  if (!m) return [0.965, 0.910, 0.894];   // #f6e8e4, the leche rosada haze
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
/**
 * How far behind the figure the chase camera rides, as a fraction of the
 * scene's extent.
 *
 * It was 0.13, which framed her nicely and showed almost none of the ground
 * she was crossing — so every replay started with the same reflex, a scroll
 * back to see where the route was going. 0.221 is that distance plus 70%: far
 * enough back that the next bend is on screen before she reaches it.
 */
const CHASE_DIST = 0.221;

/** shortest signed angular difference, so the camera never spins the long way */
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
/** frame-rate independent easing */
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
/** the same ramp the shaders use for fog, on this side of the fence */
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1), 0, 1);
  return t * t * (3 - 2 * t);
};

const FIG_MAX = 1500;           // vertices in the figure; the cyclist is the bigger of the two
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
  if(t<0.2)return vec3(0.180,0.541,0.314);
  if(t<0.4)return vec3(0.486,0.753,0.416);
  if(t<0.6)return vec3(0.961,0.718,0.0);
  if(t<0.8)return vec3(0.941,0.463,0.102);
  return vec3(0.910,0.086,0.180);}`;
const FOG_GLSL = `float fogf(float d){return smoothstep(uFogNear,uFogFar,d);}`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false })
            || canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL is not available in this browser');
    this.gl = gl;
    this.sky = readSky();
    // The haze and the clear colour are the page's --sky token, so they have to
    // follow it whichever way it changes: the system setting, or the switch in
    // the header (src/theme.js), which the OS knows nothing about.
    const reread = () => { this.sky = readSky(); };
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', reread);
    window.addEventListener('salpicon:theme', reread);
    const gl2 = !!(window.WebGL2RenderingContext && gl instanceof WebGL2RenderingContext);
    this.caps = {
      gl2, uint: gl2 || !!gl.getExtension('OES_element_index_uint'),
      // What the name sheet may grow to. Every WebGL device guarantees 2048.
      maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048,
    };

    // Fog is off. It was there to melt the far edge of the mesh into the sky,
    // and what it mostly did was drain the colour out of everything past the
    // middle distance — the satellite imagery people came to look at, greyed
    // out in the name of a horizon that is only ever a few kilometres away.
    this.state = { vex: 1, texture: true, curtain: true, chase: false, bike: false, fog: false,
      labels: true };
    // How far away a street name survives, in ground metres. Set from the
    // scene's own size in setGeometry, because "near" on a 2 km walk and on a
    // 60 km ride are not the same distance.
    this.lab = { near: 0, far: 1e9 };
    this.cam = { az: -2.24, pol: 0.97, dist: 1, tx: 0, ty: 0, tz: 0 };
    this.home = { az: -2.24, pol: 0.97, distScale: 1.45, bearing: 0, lift: 0.09 };
    this.chase = { dist: 0, pol: 1.10, azOffset: 0, height: 0 };
    this.cursor = 0;               // nearest sample index (array lookups)
    this.cursorF = 0;              // continuous position along the track
    this.faceAz = null;            // eased facing, so the figure never snaps
    this.hasTexture = false;
    this.hasLabels = false;
    this.hasNames = false;          // true once real words arrive; see setNames
    this.names = null;
    // 'all' or 'places'. The full OpenStreetMap sheet prints street names into
    // the ground itself, so ours stand down for it; region names float in the
    // air, which no sheet can do, and stay whatever is underneath.
    this.nameKinds = 'all';
    this.walking = false;          // true while the route is replaying
    this.walkPhase = 0;
    this.walkRate = 1;             // follows the playback speed multiplier
    this.onFrame = null;
    this.onChaseRelease = null;    // fired when a drag frees the camera from chase
    // "Grab and move": a one-finger drag slides the point everything orbits
    // around instead of swinging about it. Panning was always possible with a
    // right button or shift held, and a phone has neither — so zooming in on a
    // particular corner of a route meant orbiting until it drifted into view.
    this.panMode = false;
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
uniform sampler2D uTex,uLab;uniform float uHasTex,uHasLab,uLabNear,uLabFar,uHSpan,uFogNear,uFogFar;
uniform vec3 uLight,uSky;
varying vec2 vUv;varying vec3 vN;varying float vH;varying float vD;
${RAMP_GLSL}${FOG_GLSL}
void main(){vec3 n=normalize(vN);
  vec3 base=uHasTex>0.5?texture2D(uTex,vUv).rgb:(ramp(clamp(vH/uHSpan,0.0,1.0))*0.42+0.10);
  float lam=max(dot(n,uLight),0.0);float sky=0.5+0.5*n.z;
  vec3 col=base*(0.34+0.78*lam)+base*sky*0.16;
  col+=vec3(0.03,0.05,0.09)*(1.0-lam)*sky;
  // Street names, nearest first. vD is already here for the haze, so the only
  // new arithmetic is the smoothstep. Mixed after the lighting rather than
  // into the ground colour: painted on before it, a name on a slope facing
  // away from the sun is shaded along with the slope and stops being readable,
  // which is the one thing a name has to be.
  if(uHasLab>0.5){vec4 lb=texture2D(uLab,vUv);
    col=mix(col,lb.rgb,lb.a*(1.0-smoothstep(uLabNear,uLabFar,vD)));}
  gl_FragColor=vec4(mix(col,uSky,fogf(vD)*0.88),1.0);}`);

    /**
     * Names: a textured quad apiece, with its own opacity.
     *
     * No vertical scale and no fog. The positions arrive in final world
     * metres — the layout in _buildNames has already applied whatever the
     * ground is being scaled by — because a name has to sit a fixed height
     * above the surface whether the relief is exaggerated, true, or switched
     * off entirely, and multiplying its height by zero would bury it.
     *
     * The opacity is per vertex rather than per draw so that every name can
     * fade on its own: one going out because the camera pulled back, another
     * because a more important name took its piece of screen.
     */
    this.pLab = this._program(`
attribute vec3 aPos;attribute vec2 aUv;attribute float aA;
uniform mat4 uMVP;varying vec2 vUv;varying float vA;
void main(){vUv=aUv;vA=aA;gl_Position=uMVP*vec4(aPos,1.0);}`, `
precision highp float;
uniform sampler2D uAtlas;varying vec2 vUv;varying float vA;
void main(){vec4 c=texture2D(uAtlas,vUv);float a=c.a*vA;
  if(a<0.008)discard;gl_FragColor=vec4(c.rgb,a);}`);

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
      col: this._buf(new Float32Array([0.07, 0.54, 0.29, 1, 0.89, 0.14, 0.25, 1, 1, 1, 1, 1])),
    };
    B.fig = { pos: gl.createBuffer(), col: gl.createBuffer(), n: 0 };
    this._figPos = new Float32Array(FIG_MAX * 3);
    this._figCol = new Float32Array(FIG_MAX * 4);
    // face the route the way it runs: start near the camera, finish away from it
    this.home.bearing = g.track.bearing;
    this.home.az = g.track.bearing + Math.PI;
    this.cam.dist = g.ext * this.home.distScale;
    // Tight on purpose. Set wide, the names are technically visible from the
    // opening view and illegible at that size — the scene reads as dirty
    // rather than as labelled. They belong to the close view: nothing at the
    // distance the route opens at, names once the camera has come down to a
    // street.
    this.lab.near = g.ext * 0.02;
    this.lab.far = g.ext * 0.15;
    this.chase.dist = g.ext * CHASE_DIST;
    this.chase.height = g.hSpan * 0.02;
    this.cam.tz = (this.g.track.tz[0] || 0);
    this.resetView();
    this.setCursor(0);
  }

  /**
   * The street-name layer: a transparent picture the size of the imagery.
   *
   * Kept apart from the ground picture rather than painted into it, for two
   * reasons. It can then be faded by how far away the ground is, which is the
   * whole point — names that appear as you come down to a street and go when
   * you pull back. And its strength becomes a uniform the card reads every
   * frame, so a slider costs nothing; composited in, every change would mean
   * redrawing the canvas and uploading a couple of megabytes again.
   */
  setLabels(source) {
    const gl = this.gl;
    if (!this.labTex) this.labTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.labTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.hasLabels = true;
  }

  /**
   * The names, as words.
   *
   * Replaces the raster label layer when it arrives, which is why `labels`
   * goes off here: the two say the same things in the same places, and both
   * at once prints every street name twice, a few pixels apart.
   *
   * @param set  from buildNameSet in src/labels.js — one sheet of type and a
   *             list of where each piece of it goes
   */
  setNames(set) {
    const gl = this.gl;
    if (!set?.items?.length) return;
    if (!this.nameTex) this.nameTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.nameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, set.atlas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Mipmaps, because a name seen from far off is minified hard and without
    // them the glyphs sparkle as the camera moves. The sheet is not a power of
    // two in height, so WebGL1 would refuse to mip it — it is padded by the
    // atlas builder for exactly this reason.
    const pot = v => (v & (v - 1)) === 0;
    const mip = this.caps.gl2 || (pot(set.atlas.width) && pot(set.atlas.height));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);

    this.names = set.items;
    this.fade = new Float32Array(set.items.length);   // where each one is between gone and here
    const max = set.items.length * 6;
    this._nPos = new Float32Array(max * 3);
    this._nUv = new Float32Array(max * 2);
    this._nA = new Float32Array(max);
    this._nStem = new Float32Array(set.items.length * 6);
    this._nStemCol = new Float32Array(set.items.length * 8);
    const B = this._buffers;
    // A change of theme re-typesets the whole sheet and comes back through
    // here, so whatever was allocated last time goes first.
    for (const old of [B.lab, B.stem]) {
      if (old) for (const k of ['pos', 'uv', 'a', 'col']) if (old[k]) gl.deleteBuffer(old[k]);
    }
    B.lab = { pos: gl.createBuffer(), uv: gl.createBuffer(), a: gl.createBuffer(), n: 0 };
    B.stem = { pos: gl.createBuffer(), col: gl.createBuffer(), n: 0 };
    this.hasNames = true;
    this.state.labels = false;             // the raster layer steps aside
  }

  /**
   * Lay the names out for this frame, in screen terms.
   *
   * Done on the processor, every frame, and that is not an oversight. Three of
   * the things a name has to do cannot be expressed as a fixed piece of
   * geometry: a region name must turn to face wherever the camera now is; both
   * kinds must hold a sensible size on screen rather than the size perspective
   * would give them; and no name may sit on top of another, which is a
   * question about pixels and therefore about this frame. A few hundred labels
   * is a few thousand multiplications — far less than one tree of the terrain
   * mesh — and it buys all three.
   *
   * The order matters. Candidates are considered by how much they deserve the
   * space, so when two collide it is the smaller road that goes, and a region
   * name never loses to a street.
   */
  _buildNames(eye, W, H) {
    const B = this._buffers;
    if (!this.hasNames) return;
    const g = this.g, m = this._MVP, V = this._V, vex = this.state.vex;
    const items = this.names, fade = this.fade;
    const dt = this._nDt || 0.016;

    // Metres per screen pixel at a given distance, for a 45° vertical field.
    const TAN = Math.tan(45 * D2R / 2);
    const wppAt = d => 2 * d * TAN / H;

    // A horizontal camera-right, so region names stay upright. A full
    // spherical billboard would tilt the words whenever the camera looked
    // down, which is most of the time here.
    let rx = V[0], ry = V[4];
    const rl = Math.hypot(rx, ry) || 1; rx /= rl; ry /= rl;

    const clearance = (g.track.lift || 2) * 2.2;      // above the ribbon, always
    const hover = Math.max(g.hSpan * 0.35, g.ext * 0.04);

    const cand = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const place = it.kind === 'place';
      if (!place && this.nameKinds === 'places') continue;
      const z = it.z * vex + (place ? hover : clearance);
      const d = Math.hypot(it.x - eye[0], it.y - eye[1], z - eye[2]);
      const wpp = wppAt(d);

      // How tall on screen, and how tall that makes it on the ground.
      //
      // A street name is sized in metres, so it belongs to the ground and
      // grows as you come down to it the way the street does. Where that
      // would make it unreadably small it is simply not drawn, and where it
      // would make it absurdly large it is held back — a name is a label, not
      // a billboard painted on the tarmac.
      let hPx, hM, size = 1;
      if (place) {
        hPx = 15 + it.rank * 1.5;                     // a city reads larger than a barrio
        hM = hPx * wpp;
      } else {
        // How big the name is drawn on the ground, by what kind of road it is.
        // An avenue's name is set larger than a cul-de-sac's for the same
        // reason it is on a paper map: it is the one you are navigating by,
        // and it should be readable from further off and stay readable for
        // longer. The spread is about a third between the two extremes.
        const streetM = g.ext * (0.0032 + it.rank * 0.00045);
        const raw = streetM / wpp;
        if (raw < 6.5) continue;                      // too far to read: not drawn at all
        // Which is also how street names arrive and leave: by becoming legible
        // rather than by crossing a distance. The same rule then holds on a
        // phone and on a desktop, where the same distance is a different
        // number of pixels.
        size = smooth(6.5, 11, raw);
        // The ceiling rises with the road's standing too, so a main road's
        // name keeps growing a little after a side street's has stopped.
        hM = Math.max(10, Math.min(30 + it.rank * 1.2, raw)) * wpp;
        hPx = hM / wpp;
      }
      const wM = hM * it.aspect;

      // Where the middle of it lands on screen, and whether it is in front.
      const cw = m[3] * it.x + m[7] * it.y + m[11] * z + m[15];
      if (cw <= 0) continue;
      const sx = (m[0] * it.x + m[4] * it.y + m[8] * z + m[12]) / cw;
      const sy = (m[1] * it.x + m[5] * it.y + m[9] * z + m[13]) / cw;
      if (sx < -1.6 || sx > 1.6 || sy < -1.6 || sy > 1.6) continue;

      // Its footprint in pixels. A street name lies flat, so perspective
      // squashes it and the box has to be measured rather than assumed; a
      // region name faces us and is exactly as big as it asked to be.
      // The two vectors the quad is built on, half a width and half a height.
      //
      // A region name is a plain upright billboard. A street name is the
      // interesting one, and the reason it is not simply laid flat on the
      // ground: a flat label seen at a grazing angle is stretched into a
      // streak, the near end magnified several times over while the far end
      // vanishes — which is precisely the softness that made the old raster
      // labels unreadable, and would have been inherited whole.
      //
      // So it keeps the street's direction and gives up only the rest. The
      // long axis stays along the road; the short axis is turned out of the
      // ground until the face of the quad points as near the camera as it can
      // while still containing that axis. Looking straight down, that is flat
      // on the road, like a map. From anything lower, the words tilt up to
      // meet the eye, standing along the street instead of lying on it — and
      // at every angle they keep the size they asked for, because nothing is
      // foreshortened any more.
      let ax, ay, az, bx, by, bz;
      if (place) {
        ax = rx * wM / 2; ay = ry * wM / 2; az = 0;
        bx = 0; by = 0; bz = hM / 2;
      } else {
        let ux = Math.cos(it.dir), uy = Math.sin(it.dir);
        // Which way along the street the words run is a question about where
        // the camera is, not about the street, and the answer changes the
        // moment anybody orbits. Whichever direction points rightwards on
        // screen is the one they read in.
        if (ux * rx + uy * ry < 0) { ux = -ux; uy = -uy; }
        // the part of "towards the camera" that is square to the street
        let vx = eye[0] - it.x, vy = eye[1] - it.y, vz = eye[2] - z;
        const vl = Math.hypot(vx, vy, vz) || 1; vx /= vl; vy /= vl; vz /= vl;
        const along = vx * ux + vy * uy;
        let nx = vx - along * ux, ny = vy - along * uy, nz = vz;
        const nl = Math.hypot(nx, ny, nz);
        // Looking straight down the street there is no such part: the label
        // is edge-on whatever is done with it, so it lies flat and takes
        // whatever foreshortening comes.
        if (nl < 1e-4) { nx = 0; ny = 0; nz = 1; } else { nx /= nl; ny /= nl; nz /= nl; }
        // up = n x u, flipped if it would stand the words on their head
        let wx = ny * 0 - nz * uy, wy = nz * ux - nx * 0, wz = nx * uy - ny * ux;
        const wl = Math.hypot(wx, wy, wz) || 1; wx /= wl; wy /= wl; wz /= wl;
        if (wz < 0) { wx = -wx; wy = -wy; wz = -wz; }
        ax = ux * wM / 2; ay = uy * wM / 2; az = 0;
        bx = wx * hM / 2; by = wy * hM / 2; bz = wz * hM / 2;
      }

      // Its footprint in pixels, measured from the corners rather than
      // assumed: the quad faces the camera only as far as it is allowed to,
      // so what it covers is still worth asking about.
      let halfW, halfH;
      {
        let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity;
        for (const [sa, sb] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const qx = it.x + ax * sa + bx * sb, qy = it.y + ay * sa + by * sb, qz = z + az * sa + bz * sb;
          const qw = m[3] * qx + m[7] * qy + m[11] * qz + m[15];
          if (qw <= 0) { lo = Infinity; break; }
          const ppx = (m[0] * qx + m[4] * qy + m[8] * qz + m[12]) / qw * W / 2;
          const ppy = (m[1] * qx + m[5] * qy + m[9] * qz + m[13]) / qw * H / 2;
          if (ppx < lo) lo = ppx; if (ppx > hi) hi = ppx;
          if (ppy < lo2) lo2 = ppy; if (ppy > hi2) hi2 = ppy;
        }
        if (!isFinite(lo)) continue;
        halfW = (hi - lo) / 2; halfH = (hi2 - lo2) / 2;
        if (halfH < 3) continue;                      // edge-on to the camera: unreadable
      }

      // Region names have no distance limit at all: knowing which barrio this
      // is stays true from any height, and that is the whole difference
      // between the two kinds.
      const far = place ? 1 : size;
      if (far <= 0.01) continue;

      cand.push({
        i, it, place, z, ax, ay, az, bx, by, bz, want: far,
        px: sx * W / 2, py: sy * H / 2, halfW, halfH,
        key: (place ? 1000 : 0) + it.rank * 10 - Math.min(9, d / Math.max(1, g.ext) * 9),
      });
    }

    // The ones that deserve the space take it; anything that would land on top
    // of one already placed is let go, and fades rather than blinking out.
    cand.sort((a, b) => b.key - a.key);
    const kept = [];
    const want = new Float32Array(items.length);
    for (const c of cand) {
      let clash = false;
      for (const k of kept) {
        // The gap two labels must leave each other. Three pixels was a
        // comfortable printed-map margin and it was what actually set the
        // density of the whole layer — candidates were plentiful and this
        // threw most of them away.
        if (Math.abs(c.px - k.px) < c.halfW + k.halfW + 1
         && Math.abs(c.py - k.py) < c.halfH + k.halfH + 1) { clash = true; break; }
      }
      if (clash) continue;
      kept.push(c);
      want[c.i] = c.want;
    }

    // Ease every name towards where it should be, so collisions and distance
    // both read as a name arriving or leaving rather than as a flicker.
    const k = ease(5.5, dt);
    for (let i = 0; i < items.length; i++) fade[i] += (want[i] - fade[i]) * k;

    const P = this._nPos, U = this._nUv, A = this._nA;
    const S = this._nStem, SC = this._nStemCol;
    let v = 0, sv = 0;
    for (const c of kept) {
      const a = fade[c.i];
      if (a < 0.01) continue;
      const it = c.it;
      const { ax, ay, az, bx, by, bz } = c;           // worked out above, with the camera
      const corner = (sa, sb, u, w) => {
        P[v * 3] = it.x + ax * sa + bx * sb;
        P[v * 3 + 1] = it.y + ay * sa + by * sb;
        P[v * 3 + 2] = c.z + az * sa + bz * sb;
        U[v * 2] = u; U[v * 2 + 1] = w;
        A[v] = a;
        v++;
      };
      // v0 is the top of the row in the sheet, which is why the bottom corners
      // take v1: the atlas is uploaded without a flip.
      corner(-1, 1, it.u0, it.v0); corner(-1, -1, it.u0, it.v1); corner(1, 1, it.u1, it.v0);
      corner(1, 1, it.u1, it.v0); corner(-1, -1, it.u0, it.v1); corner(1, -1, it.u1, it.v1);

      // A region name floating with nothing under it reads as a sticker on the
      // lens. The stem says which piece of ground it belongs to.
      if (c.place) {
        const gz = it.z * vex;
        S[sv * 3] = it.x; S[sv * 3 + 1] = it.y; S[sv * 3 + 2] = gz;
        S[sv * 3 + 3] = it.x; S[sv * 3 + 4] = it.y; S[sv * 3 + 5] = c.z - Math.abs(c.bz) * 1.1;
        for (const [j, al] of [[0, 0.0], [1, 0.45]]) {
          SC[(sv + j) * 4] = 0.10; SC[(sv + j) * 4 + 1] = 0.13; SC[(sv + j) * 4 + 2] = 0.11;
          SC[(sv + j) * 4 + 3] = al * a;
        }
        sv += 2;
      }
    }

    const gl = this.gl;
    B.lab.n = v; B.stem.n = sv;
    if (v) {
      gl.bindBuffer(gl.ARRAY_BUFFER, B.lab.pos); gl.bufferData(gl.ARRAY_BUFFER, P.subarray(0, v * 3), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, B.lab.uv); gl.bufferData(gl.ARRAY_BUFFER, U.subarray(0, v * 2), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, B.lab.a); gl.bufferData(gl.ARRAY_BUFFER, A.subarray(0, v), gl.DYNAMIC_DRAW);
    }
    if (sv) {
      gl.bindBuffer(gl.ARRAY_BUFFER, B.stem.pos); gl.bufferData(gl.ARRAY_BUFFER, S.subarray(0, sv * 3), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, B.stem.col); gl.bufferData(gl.ARRAY_BUFFER, SC.subarray(0, sv * 4), gl.DYNAMIC_DRAW);
    }
  }

  setTexture(source) {
    const gl = this.gl;
    // Freed first: the street-map switch calls this every time it is pressed,
    // and a new texture per press is a couple of megabytes of video memory
    // left behind on each one.
    if (this.texture) gl.deleteTexture(this.texture);
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

  /**
   * How tall the walking figure stands, in metres.
   *
   * Two scene-relative terms keep her readable on a long route, and the 1.7 m
   * floor is there for the other end: on a soccer pitch every relative term
   * collapses, and a person is the one thing in the scene whose real size we
   * actually know.
   */
  figureSize() {
    return this.g ? Math.max(this.g.track.width * 1.5, this.g.ext * 0.006, 1.7) : 1;
  }

  _updateMarkers() {
    const gl = this.gl, t = this.g.track, B = this._buffers;
    const lift = t.lift;              // the same clearance the ribbon is drawn at
    // the cursor dot rides just above the walker's head, so the position still
    // reads when the figure itself is only a few pixels tall
    // Drawn with uVex pinned to 1 (see the frame loop), so these are already
    // world heights: the ground's own scale is applied here instead.
    const vex = this.state.vex;
    const overhead = this.figureSize() * 1.35;
    const p = this._pos();
    gl.bindBuffer(gl.ARRAY_BUFFER, B.mk.pos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      t.tx[0], t.ty[0], (t.tz[0] + lift) * vex,
      t.tx[t.n - 1], t.ty[t.n - 1], (t.tz[t.n - 1] + lift) * vex,
      p[0], p[1], p[2] * vex + overhead,
    ]), gl.DYNAMIC_DRAW);
  }

  /**
   * The walker: a low-poly take on the restroom-sign woman, legs and arms
   * swinging from hip and shoulder.
   */
  poseWalker({ S, ph, quad, block, limb, frustum }) {
    const legA = Math.sin(ph) * 0.55, armA = Math.sin(ph + Math.PI) * 0.42;
    const body = [0.97, 0.97, 0.95], skin = [1.0, 1.0, 1.0];   // white, like the figure on a crossing light

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
      const nrm = [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4,
                   (a[2] + b[2] + c[2] + d[2]) / 4 - hz];
      quad(a, b, c, d, skin, nrm);
    }
  }

  /**
   * The cyclist: same rider, folded onto a bike.
   *
   * Built to the same `S` as the walker so swapping does not change how big
   * she reads on the terrain — a bike plus a crouched rider is taller than a
   * standing person, so the whole thing is drawn at 0.82 of the figure size
   * and comes out the same height on screen.
   *
   * The wheels are flat rings rather than solids. Nothing here is lit from
   * inside and WebGL draws both faces by default, so a ring costs twenty
   * triangles instead of the hundreds a tyre-shaped tube would.
   */
  poseCyclist({ S, ph, quad, poly8, block }) {
    const B = S * 0.82;
    const body = [0.97, 0.97, 0.95], skin = [1.0, 1.0, 1.0];
    const frame = [0.96, 0.72, 0.0], rubber = [0.21, 0.20, 0.16];   // tyres light enough to read on dark ground

    /** a box between two points in the x–z plane, `w` thick each way */
    const strut = (ax, az, bx, bz, y, w, col) => {
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
      const px = -dz / len * w, pz = dx / len * w;              // across the bar
      const c = (x, z, sy, sp) => [x + px * sp, y + sy * w, z + pz * sp];
      poly8([c(ax, az, -1, -1), c(bx, bz, -1, -1), c(bx, bz, 1, -1), c(ax, az, 1, -1),
             c(ax, az, -1, 1), c(bx, bz, -1, 1), c(bx, bz, 1, 1), c(ax, az, 1, 1)], col, 0, 0);
    };
    /** a wheel: a flat ring standing in the x–z plane */
    const wheel = (cx, cz, r, y) => {
      const SEG = 11, inner = r * 0.70;
      for (let k = 0; k < SEG; k++) {
        const a = 2 * Math.PI * k / SEG, b = 2 * Math.PI * (k + 1) / SEG;
        quad([cx + r * Math.cos(a), y, cz + r * Math.sin(a)],
             [cx + r * Math.cos(b), y, cz + r * Math.sin(b)],
             [cx + inner * Math.cos(b), y, cz + inner * Math.sin(b)],
             [cx + inner * Math.cos(a), y, cz + inner * Math.sin(a)], rubber, [0, 1, 0.35]);
      }
    };

    const R = 0.33 * B, hubZ = R;                      // wheels
    const rearX = -0.60 * B, frontX = 0.62 * B;
    wheel(rearX, hubZ, R, 0); wheel(frontX, hubZ, R, 0);

    const bbX = 0.02 * B, bbZ = 0.25 * B;              // bottom bracket (the cranks)
    const seatX = -0.30 * B, seatZ = 0.70 * B;         // saddle
    const barX = 0.44 * B, barZ = 0.66 * B;            // handlebar
    const t = 0.021 * B;
    strut(rearX, hubZ, bbX, bbZ, 0, t, frame);         // chain stay
    strut(bbX, bbZ, seatX, seatZ, 0, t, frame);        // seat tube
    strut(rearX, hubZ, seatX, seatZ, 0, t, frame);     // seat stay
    strut(bbX, bbZ, barX, barZ, 0, t, frame);          // down tube
    strut(seatX, seatZ, barX, barZ, 0, t, frame);      // top tube
    strut(frontX, hubZ, barX, barZ, 0, t, frame);      // fork
    block(barX - t, barX + t, -0.15 * B, 0.15 * B, barZ - t, barZ + t, frame);        // handlebar
    block(seatX - 0.07 * B, seatX + 0.05 * B, -0.04 * B, 0.04 * B, seatZ, seatZ + 1.4 * t, frame);  // saddle

    // rider: hips on the saddle, shoulders forward over the bars
    const hipX = seatX + 0.05 * B, hipZ = seatZ + 0.05 * B;
    const shX = 0.10 * B, shZ = 1.00 * B;
    strut(hipX, hipZ, shX, shZ, 0, 0.062 * B, body);                  // torso, leaning in
    for (const side of [-1, 1]) strut(shX, shZ, barX, barZ + t, side * 0.075 * B, 0.023 * B, body);

    // legs: feet ride the cranks, half a turn apart, and the knee is placed by
    // two-bone inverse kinematics so the bend reads as pedalling
    // bones long enough to reach the pedal at the bottom of the stroke, or the
    // shin stretches like rubber when the crank swings away from the hip
    const crank = 0.115 * B, thigh = 0.355 * B;
    for (const side of [-1, 1]) {
      const a = ph + (side > 0 ? 0 : Math.PI);
      const fx = bbX + crank * Math.cos(a), fz = bbZ + crank * Math.sin(a);
      const dx = fx - hipX, dz = fz - hipZ, d = Math.max(0.05 * B, Math.hypot(dx, dz));
      const reach = Math.min(d, thigh * 1.98) / 2;
      const bulge = Math.sqrt(Math.max(0, thigh * thigh - reach * reach));
      const ux = dx / d, uz = dz / d;
      // the knee bends forward, over the bars — the other perpendicular puts it
      // behind the rider and she pedals like a bird
      const kx = hipX + ux * reach - uz * bulge, kz = hipZ + uz * reach + ux * bulge;
      const y = side * 0.07 * B;
      strut(hipX, hipZ, kx, kz, y, 0.040 * B, body);                  // thigh
      strut(kx, kz, fx, fz, y, 0.031 * B, body);                      // shin
    }

    // head, tipped forward over the bars
    const hr = 0.082 * B, hx = shX + 0.075 * B, hz = shZ + hr * 0.75, LON = 7, LAT = 5;
    const sp = (j, k) => {
      const phi = Math.PI * j / LAT, th = 2 * Math.PI * k / LON;
      return [hx + hr * Math.sin(phi) * Math.cos(th), hr * Math.sin(phi) * Math.sin(th), hz + hr * Math.cos(phi)];
    };
    for (let j = 0; j < LAT; j++) for (let k = 0; k < LON; k++) {
      const a = sp(j, k), b = sp(j, k + 1), c = sp(j + 1, k + 1), d = sp(j + 1, k);
      const nrm = [(a[0] + b[0] + c[0] + d[0]) / 4 - hx, (a[1] + b[1] + c[1] + d[1]) / 4,
                   (a[2] + b[2] + c[2] + d[2]) / 4 - hz];
      quad(a, b, c, d, skin, nrm);
    }
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
    const S = this.figureSize(), vex = this.state.vex;   // only to place her on the ground
    const h = this.faceAz === null ? this._facing() : this.faceAz;
    const ch = Math.cos(h), sh = Math.sin(h);
    const ph = this.walkPhase;
    // the walker bobs on each step; a rider's saddle does not
    const bob = this.state.bike ? 0 : (Math.abs(Math.sin(ph)) - 0.5) * 0.025 * S;
    const p = this._pos(), ox = p[0], oy = p[1], oz = p[2] * vex;

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
      P[n * 3 + 2] = oz + p[2] + bob;             // true metres; see _buildFigure
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

    // Everything above builds solids out of eight corners; which solids get
    // built is the only thing that separates the two figures.
    const kit = { S, ph, quad, poly8, block, limb, frustum };
    if (this.state.bike) this.poseCyclist(kit); else this.poseWalker(kit);

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
    if (this.g) this.chase.dist = this.g.ext * CHASE_DIST;
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
      this.chase.dist = this.g.ext * CHASE_DIST;
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
      const panning = drag.pan || this.panMode;
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
      } else if (panning) {
        this._pan(dx, dy);
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
    let pinch = null, mid = null;
    c.addEventListener('touchmove', e => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = e.touches;
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
        if (pinch) {
          const ext = this.g ? this.g.ext : 1, k = pinch / d;
          if (this.state.chase) this.chase.dist = clamp(this.chase.dist * k, ext * 0.02, ext * 0.9);
          else this.cam.dist = clamp(this.cam.dist * k, ext * 0.06, ext * 3.2);
        }
        // Two fingers slide the ground, whatever mode the one-finger drag is
        // in. Free the camera first, since chase owns where it is looking and
        // would drag the view straight back.
        if (mid && !this.state.chase) this._pan(mx - mid[0], my - mid[1]);
        pinch = d; mid = [mx, my];
      } else { pinch = null; mid = null; }
    }, { passive: false });
    c.addEventListener('touchend', () => { pinch = null; mid = null; });
    window.addEventListener('resize', () => this._resize());
  }

  /**
   * Repaint the route from something other than its height.
   *
   * The ribbon, its halo and the curtain under it are coloured once, on the
   * CPU, when the geometry is built — so switching what the colours *mean*
   * does not need the terrain rebuilt, only three colour buffers rewritten.
   * `norm[i]` is the value for sample i already scaled to 0…1; what it stands
   * for is the caller's business. The ramp comes in as a function for the same
   * reason — this file has no imports and is not about to grow one for five
   * colours it does not otherwise need.
   *
   * @param {ArrayLike<number>} norm  one value per track sample, 0…1
   * @param {(t:number)=>number[]} shade  0…1 to [r,g,b], each 0…1
   */
  recolourRoute(norm, shade) {
    const g = this.g;
    if (!g) return;
    const gl = this.gl, B = this._buffers, M = g.track.n;
    const rc = g.ribbon.col, wc = g.curtain.col;
    for (let i = 0; i < M; i++) {
      const c = shade(clamp(norm[i] ?? 0, 0, 1));
      // two vertices per sample for the ribbon, and the curtain fades out
      // upward, so only its colour changes and not the alpha it was given
      for (const k of [0, 4]) {
        rc[i * 8 + k] = c[0]; rc[i * 8 + k + 1] = c[1]; rc[i * 8 + k + 2] = c[2];
      }
      wc[i * 8] = c[0]; wc[i * 8 + 1] = c[1]; wc[i * 8 + 2] = c[2];
      wc[i * 8 + 4] = c[0]; wc[i * 8 + 5] = c[1]; wc[i * 8 + 6] = c[2];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, B.rib.col);
    gl.bufferData(gl.ARRAY_BUFFER, rc, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, B.wall.col);
    gl.bufferData(gl.ARRAY_BUFFER, wc, gl.STATIC_DRAW);
  }

  /**
   * Slide the orbit centre across the ground, in screen terms.
   *
   * Scaled by the camera's distance so a drag moves the ground by about the
   * same number of pixels whatever the zoom — close in it creeps, far out it
   * sweeps, which is what makes it feel like dragging the map rather than
   * driving a dial.
   *
   * Both axes carry the drag the way a hand would: the ground follows the
   * finger. Pulling down brings what is above the cursor down towards it,
   * which is the opposite of moving the camera down, and is the one that feels
   * like paper rather than a scrollbar.
   */
  _pan(dx, dy) {
    const s = this.cam.dist * 0.0016;
    this.cam.tx += (Math.sin(this.cam.az) * dx - Math.cos(this.cam.az) * dy) * s;
    this.cam.ty += (-Math.cos(this.cam.az) * dx - Math.sin(this.cam.az) * dy) * s;
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
      gl.clearColor(this.sky[0], this.sky[1], this.sky[2], 1);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!this.g) return;

      const eye = this._eye(), tgt = [this.cam.tx, this.cam.ty, this.cam.tz * this.state.vex];
      perspective(this._P, 45 * D2R, W / H, this.g.ext / 500, this.g.ext * 16);
      lookAt(this._V, eye, tgt, [0, 0, 1]);
      mul(this._MVP, this._P, this._V);
      // Haze would follow the camera distance, so that zooming out never dims
      // the scene. With it off, both edges go beyond anything the depth buffer
      // will hold, so smoothstep returns 0 everywhere and the shaders need no
      // branch of their own.
      const fogN = this.state.fog ? this.cam.dist * 0.95 : 1e9;
      const fogF = this.state.fog ? this.cam.dist * 3.0 : 1e9 + 1;
      const useTex = this.hasTexture && this.state.texture ? 1 : 0;
      const B = this._buffers, pT = this.pTer, pC = this.pCol;

      gl.useProgram(pT);
      gl.uniformMatrix4fv(pT.u.uMVP, false, this._MVP);
      gl.uniform1f(pT.u.uVex, this.state.vex);
      gl.uniform3fv(pT.u.uCam, eye);
      gl.uniform1f(pT.u.uHasTex, useTex);
      gl.uniform1f(pT.u.uHSpan, this.g.hSpan);
      gl.uniform3fv(pT.u.uLight, new Float32Array([Math.cos(0.86) * Math.cos(0.62), Math.sin(0.86) * Math.cos(0.62), Math.sin(0.62)]));
      gl.uniform3fv(pT.u.uSky, new Float32Array(this.sky));
      gl.uniform1f(pT.u.uFogNear, fogN); gl.uniform1f(pT.u.uFogFar, fogF);
      if (useTex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture); gl.uniform1i(pT.u.uTex, 0); }
      const useLab = this.hasLabels && this.state.labels && useTex ? 1 : 0;
      gl.uniform1f(pT.u.uHasLab, useLab);
      gl.uniform1f(pT.u.uLabNear, this.lab.near);
      gl.uniform1f(pT.u.uLabFar, this.lab.far);
      if (useLab) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.labTex); gl.uniform1i(pT.u.uLab, 1); }
      this._attr(pT, 'aPos', B.ter.pos, 3); this._attr(pT, 'aSlope', B.ter.slope, 2); this._attr(pT, 'aUv', B.ter.uv, 2);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, B.ter.idx);
      gl.drawElements(gl.TRIANGLES, B.ter.n, B.ter.type, 0);

      gl.useProgram(pC);
      gl.uniformMatrix4fv(pC.u.uMVP, false, this._MVP);
      gl.uniform1f(pC.u.uVex, this.state.vex);
      gl.uniform3fv(pC.u.uCam, eye);
      gl.uniform3fv(pC.u.uSky, new Float32Array(this.sky));
      gl.uniform1f(pC.u.uFogNear, fogN); gl.uniform1f(pC.u.uFogFar, fogF);
      gl.uniform1f(pC.u.uIsPoint, 0); gl.uniform1f(pC.u.uPointSize, 1);
      gl.disable(gl.BLEND);
      this._attr(pC, 'aPos', B.skirt.pos, 3); this._attr(pC, 'aCol', B.skirt.col, 4);
      gl.drawArrays(gl.TRIANGLES, 0, B.skirt.n);

      // one strip per recorded segment: a paused stretch leaves a gap rather
      // than a line across whatever happened while the recording was stopped
      const strips = this.g.track.strips ?? [{ first: 0, count: B.rib.n }];
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-2.0, -3);
      this._attr(pC, 'aPos', B.out.pos, 3); this._attr(pC, 'aCol', B.out.col, 4);
      for (const s of strips) gl.drawArrays(gl.TRIANGLE_STRIP, s.first, s.count);
      gl.polygonOffset(-4.0, -8);
      this._attr(pC, 'aPos', B.rib.pos, 3); this._attr(pC, 'aCol', B.rib.col, 4);
      for (const s of strips) gl.drawArrays(gl.TRIANGLE_STRIP, s.first, s.count);
      gl.disable(gl.POLYGON_OFFSET_FILL);

      // She is built in real metres on ground that has already been scaled, so
      // the vertical scale must not be applied to her a second time. It goes
      // back to the ground's own value for the curtain below.
      this._buildFigure();
      gl.uniform1f(pC.u.uVex, 1);
      this._attr(pC, 'aPos', B.fig.pos, 3); this._attr(pC, 'aCol', B.fig.col, 4);
      gl.drawArrays(gl.TRIANGLES, 0, B.fig.n);
      gl.uniform1f(pC.u.uVex, this.state.vex);

      if (this.state.curtain) {
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
        this._attr(pC, 'aPos', B.wall.pos, 3); this._attr(pC, 'aCol', B.wall.col, 4);
        for (const s of (this.g.track.strips ?? [{ first: 0, count: B.wall.n }]))
          gl.drawArrays(gl.TRIANGLE_STRIP, s.first, s.count);
        gl.depthMask(true); gl.disable(gl.BLEND);
      }

      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(pC.u.uIsPoint, 1);
      gl.uniform1f(pC.u.uVex, 1);                 // scaled in _updateMarkers, as above
      gl.uniform1f(pC.u.uPointSize, Math.max(9, Math.min(20, H * 0.016)));
      this._attr(pC, 'aPos', B.mk.pos, 3); this._attr(pC, 'aCol', B.mk.col, 4);
      gl.drawArrays(gl.POINTS, 0, 3);
      gl.disable(gl.BLEND);

      // The names, last of everything.
      //
      // Last because a name is the one thing on the ground that nothing else
      // may cover: the route is the subject, and the route running down a
      // street is exactly where its name wants to be. The depth test still
      // applies, so a hill in front of a name hides it — what is overcome is
      // only the ribbon, by a polygon offset deeper than the ribbon's own.
      if (this.hasNames) {
        this._nDt = dt;
        this._buildNames(eye, W, H);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        if (B.stem.n) {
          gl.uniform1f(pC.u.uIsPoint, 0);
          gl.uniform1f(pC.u.uVex, 1);           // stems are built in final metres
          this._attr(pC, 'aPos', B.stem.pos, 3); this._attr(pC, 'aCol', B.stem.col, 4);
          gl.drawArrays(gl.LINES, 0, B.stem.n);
        }
        if (B.lab.n) {
          const pL = this.pLab;
          gl.useProgram(pL);
          gl.uniformMatrix4fv(pL.u.uMVP, false, this._MVP);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.nameTex);
          gl.uniform1i(pL.u.uAtlas, 0);
          this._attr(pL, 'aPos', B.lab.pos, 3);
          this._attr(pL, 'aUv', B.lab.uv, 2);
          this._attr(pL, 'aA', B.lab.a, 1);
          gl.enable(gl.POLYGON_OFFSET_FILL);
          gl.polygonOffset(-9.0, -24);          // deeper than the ribbon's -4 / -8
          gl.drawArrays(gl.TRIANGLES, 0, B.lab.n);
          gl.disable(gl.POLYGON_OFFSET_FILL);
        }
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
    };
    requestAnimationFrame(frame);
  }
}
