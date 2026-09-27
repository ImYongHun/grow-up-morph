// WebGL 삼각형 메쉬 워핑: 여러 원본 이미지를 하나의 목표 얼굴형으로 휘게 만든 뒤 가중치로 섞음
import { W, H } from './face.js';

const VS = `
attribute vec2 a_pos;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos.x / ${W}.0 * 2.0 - 1.0, 1.0 - a_pos.y / ${H}.0 * 2.0, 0.0, 1.0);
}`;

const FS = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_weight;
void main() {
  gl_FragColor = vec4(texture2D(u_tex, v_uv).rgb * u_weight, u_weight);
}`;

export class MorphRenderer {
  constructor(canvas) {
    canvas.width = W;
    canvas.height = H;
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: true });
    if (!gl) throw new Error('이 브라우저는 WebGL을 지원하지 않습니다');
    this.gl = gl;
    this.textures = new Map();
    this.prog = this.#program(VS, FS);
    this.aPos = gl.getAttribLocation(this.prog, 'a_pos');
    this.aUv = gl.getAttribLocation(this.prog, 'a_uv');
    this.uWeight = gl.getUniformLocation(this.prog, 'u_weight');
    this.posBuf = gl.createBuffer();
    this.uvBuf = gl.createBuffer();
    this.idxBuf = gl.createBuffer();
    this.triCount = 0;
  }

  #program(vs, fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  setTriangles(triangles) {
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(triangles), gl.STATIC_DRAW);
    this.triCount = triangles.length;
  }

  #texture(source) {
    let tex = this.textures.get(source);
    if (tex) return tex;
    const gl = this.gl;
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(source, tex);
    return tex;
  }

  clearTextures() {
    for (const t of this.textures.values()) this.gl.deleteTexture(t);
    this.textures.clear();
  }

  // 레이어 하나를 담아둘 오프스크린 버퍼 (겹치는 삼각형이 두 번 더해져 하얗게 뜨는 것 방지)
  #ensureFbo() {
    if (this.fbo) return;
    const gl = this.gl;
    this.fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // 화면 전체 사각형 (FBO 는 위아래가 뒤집혀 저장되므로 v 를 반전)
    this.quadPos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadPos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, W, 0, 0, H, W, 0, W, H, 0, H]), gl.STATIC_DRAW);
    this.quadUv = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadUv);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0]), gl.STATIC_DRAW);
  }

  #attrib(loc, buf) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  // layers: [{ canvas, pts, weight }] — 각 layer 를 dstPts 형태로 워핑해 가중합
  render(layers, dstPts) {
    const gl = this.gl;
    this.#ensureFbo();
    gl.useProgram(this.prog);
    gl.viewport(0, 0, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(dstPts.flat()), gl.DYNAMIC_DRAW);

    for (const { canvas, pts, weight } of layers) {
      if (weight <= 0.001) continue;

      // 1) 워핑 → FBO (덮어쓰기)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);
      const uv = new Float32Array(pts.length * 2);
      pts.forEach(([x, y], i) => { uv[i * 2] = x / W; uv[i * 2 + 1] = y / H; });
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, uv, gl.DYNAMIC_DRAW);
      this.#attrib(this.aPos, this.posBuf);
      this.#attrib(this.aUv, this.uvBuf);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.#texture(canvas));
      gl.uniform1f(this.uWeight, 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
      gl.drawElements(gl.TRIANGLES, this.triCount, gl.UNSIGNED_SHORT, 0);

      // 2) FBO → 화면에 가중치만큼 더하기
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.#attrib(this.aPos, this.quadPos);
      this.#attrib(this.aUv, this.quadUv);
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
      gl.uniform1f(this.uWeight, weight);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  dispose() {
    this.clearTextures();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  // 현재 렌더 결과를 독립 캔버스로 복사
  snapshot() {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    c.getContext('2d').drawImage(this.canvas, 0, 0);
    return c;
  }
}
