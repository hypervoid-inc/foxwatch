struct Frame {
  viewProjection: mat4x4f,
  model: mat4x4f,
  cameraPosition: vec3f,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> frame: Frame;

struct VertexIn {
  @location(0) corner: vec2f,
  @location(1) a: vec3f,
  @location(2) b: vec3f,
  @location(3) color: vec3f,
  @location(4) width: f32,
  @location(5) along0: f32,
  @location(6) along1: f32,
  @location(7) dash: f32,
};

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
  @location(1) along: f32,
  @location(2) dash: f32,
};

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  let worldA = (frame.model * vec4f(input.a, 1.0)).xyz;
  let worldB = (frame.model * vec4f(input.b, 1.0)).xyz;
  let along = mix(worldA, worldB, input.corner.y);
  let span = worldB - worldA;
  let toCam = frame.cameraPosition - along;
  var side = cross(span, toCam);
  let sl = length(side);
  if (sl > 1e-6) {
    side = side / sl;
  } else {
    side = vec3f(1.0, 0.0, 0.0);
  }
  let pos = along + side * input.corner.x * input.width;
  out.clip = frame.viewProjection * vec4f(pos, 1.0);
  out.color = input.color;
  out.along = mix(input.along0, input.along1, input.corner.y);
  out.dash = input.dash;
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  if (input.dash > 0.5 && fract(input.along * 14.0) > 0.48) {
    discard;
  }
  return vec4f(input.color, 0.88);
}
