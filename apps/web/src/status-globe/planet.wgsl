struct Planet {
  viewProjection: mat4x4f,
  model: mat4x4f,
  cameraPosition: vec3f,
  _pad0: f32,
  ocean: vec3f,
  _pad1: f32,
  land: vec3f,
  _pad2: f32,
  hover: vec3f,
  _pad3: f32,
  line: vec3f,
  _pad4: f32,
};

@group(0) @binding(0) var<uniform> planet: Planet;
@group(0) @binding(1) var landMap: texture_2d<f32>;
@group(0) @binding(2) var mapSampler: sampler;

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
};

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) local: vec3f,
  @location(1) normal: vec3f,
  @location(2) world: vec3f,
};

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  let world = planet.model * vec4f(input.position, 1.0);
  out.local = input.position;
  out.normal = (planet.model * vec4f(input.normal, 0.0)).xyz;
  out.world = world.xyz;
  out.clip = planet.viewProjection * world;
  return out;
}

fn landUv(local: vec3f) -> vec2f {
  let n = normalize(local);
  let lng = atan2(n.x, n.z);
  let lat = asin(clamp(n.y, -1.0, 1.0));
  return vec2f((lng + 3.14159265) / (2.0 * 3.14159265), 0.5 - lat / 3.14159265);
}

fn graticule(uv: vec2f) -> f32 {
  let mx = abs(fract(uv.x * 24.0) - 0.5);
  let my = abs(fract(uv.y * 12.0) - 0.5);
  let gx = 1.0 - smoothstep(0.0, 0.018, mx);
  let gy = 1.0 - smoothstep(0.0, 0.022, my);
  return max(gx, gy);
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let n = normalize(input.normal);
  let lightDir = normalize(vec3f(-0.42, 0.56, 0.72));
  let viewDir = normalize(planet.cameraPosition - input.world);
  let ndl = dot(n, lightDir);
  let wrap = saturate(ndl * 0.62 + 0.38);
  let shade = 0.16 + 0.84 * wrap;
  let halfV = normalize(lightDir + viewDir);
  let spec = pow(saturate(dot(n, halfV)), 42.0);

  let uv = landUv(input.local);
  let raw = textureSample(landMap, mapSampler, uv).r;
  let land = smoothstep(0.32, 0.62, raw);
  let coast = smoothstep(0.18, 0.42, raw) * (1.0 - smoothstep(0.52, 0.82, raw));

  let ocean = mix(planet.ocean, planet.hover, 0.1 + 0.9 * shade);
  var ground = mix(planet.land, planet.line, shade * 0.28);
  ground = mix(ground, planet.hover, wrap * 0.12);
  var color = mix(ocean, ground, land);
  color = mix(color, planet.line, coast * 0.38);
  color = mix(color, planet.line, graticule(uv) * (0.1 + 0.08 * (1.0 - land)));
  color += spec * mix(0.2, 0.05, land) * wrap;
  let night = saturate(-ndl);
  color = mix(color, color * 0.55, night * 0.45);
  return vec4f(color, 1.0);
}
