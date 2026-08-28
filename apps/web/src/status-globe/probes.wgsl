struct Frame {
  viewProjection: mat4x4f,
  model: mat4x4f,
  cameraPosition: vec3f,
  _pad: f32,
  right: vec3f,
  _pad1: f32,
  up: vec3f,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> frame: Frame;

struct VertexIn {
  @location(0) corner: vec2f,
  @location(1) position: vec3f,
  @location(2) color: vec3f,
  @location(3) size: f32,
  @location(4) kind: f32,
};

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
  @location(1) corner: vec2f,
  @location(2) kind: f32,
};

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  let world = (frame.model * vec4f(input.position, 1.0)).xyz;
  let offset = frame.right * input.corner.x * input.size + frame.up * input.corner.y * input.size;
  out.clip = frame.viewProjection * vec4f(world + offset, 1.0);
  out.color = input.color;
  out.corner = input.corner;
  out.kind = input.kind;
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  if (input.kind < 0.5) {
    if (dot(input.corner, input.corner) > 1.0) {
      discard;
    }
  } else {
    let a = abs(input.corner.x) + abs(input.corner.y);
    if (a > 1.0) {
      discard;
    }
  }
  return vec4f(input.color, 1.0);
}
