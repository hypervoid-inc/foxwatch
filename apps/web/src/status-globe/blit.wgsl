@group(0) @binding(0) var src: texture_2d<f32>;

@fragment
fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let c = textureLoad(src, vec2i(pos.xy), 0);
  return vec4f(c.rgb * c.a, c.a);
}
