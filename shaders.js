/**
 * GLSL programs used by Earth 3D.
 *
 * Conventions
 *  - Lighting maths happens in world space. The Earth is centred at the world origin
 *    with radius 1, so the radial ("sphere") normal is simply the normalised position.
 *  - `uSunDir` is the normalised world-space direction from the Earth towards the Sun.
 *  - Colour textures are sampled as linear values (three.js decodes sRGB) and the
 *    `colorspace_fragment` chunk converts the result back for display.
 *  - Positions go through `modelViewMatrix` (computed in double precision on the CPU), so
 *    tiles stored relative to their centre stay jitter-free when the camera is close.
 *  - Effects measured in metres (explosion lights, scorch marks) use view-space positions:
 *    world positions near 1.0 only have ~0.7 m of float32 precision, camera-relative ones
 *    are exact to the millimetre.
 */

/* ------------------------------------------------------------------ */
/* Noise (gradient + value noise, hash without sine)                   */
/* ------------------------------------------------------------------ */
const NOISE = /* glsl */ `
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec3 hash33(vec3 p3) {
    p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return -1.0 + 2.0 * fract((p3.xxy + p3.yxx) * p3.zyx);
  }
  // Value noise, 0..1 (cheap)
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), u.x),
          mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), u.x), u.y),
      mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), u.x),
          mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), u.x), u.y), u.z);
  }
  // Gradient noise, about -0.7..0.7 (smoother, no grid artefacts)
  float gnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return mix(
      mix(mix(dot(hash33(i), f),
              dot(hash33(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0)), u.x),
          mix(dot(hash33(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0)),
              dot(hash33(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0)), u.x), u.y),
      mix(mix(dot(hash33(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0)),
              dot(hash33(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0)), u.x),
          mix(dot(hash33(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0)),
              dot(hash33(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0)), u.x), u.y), u.z);
  }
  // Fractal gradient noise, about 0..1
  float fbm(vec3 p, int octaves) {
    float sum = 0.0;
    float amp = 0.5;
    float norm = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= octaves) break;
      sum += amp * gnoise(p);
      norm += amp;
      p = p * 2.07 + vec3(13.1, 7.7, 3.3);
      amp *= 0.5;
    }
    return 0.5 + 0.75 * sum / norm;
  }
`;

/** Linear → sRGB for shaders that write premultiplied colour themselves (no colorspace chunk). */
const TO_SRGB = /* glsl */ `
  vec3 toSRGB(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }
`;

/* ------------------------------------------------------------------ */
/* Earth surface (base globe, and high-resolution tiles with TILE)     */
/* ------------------------------------------------------------------ */

export const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;   // shading normal (terrain normal for tiles)
  varying vec3 vSphereW;   // radial normal, used for the day/night terminator
  varying vec3 vEastW;
  varying vec3 vNorthW;
  varying vec3 vPosW;
  varying vec3 vViewPos;   // camera-relative position (precise at street level)

  #ifdef TILE
    attribute vec2 uvTile;
    varying vec2 vTileUv;
  #endif

  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vPosW = worldPos.xyz;

  #ifdef TILE
    vTileUv = uvTile;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vSphereW = normalize(worldPos.xyz);
    vEastW = vec3(1.0, 0.0, 0.0);
    vNorthW = vec3(0.0, 1.0, 0.0);
  #else
    vec3 n = normalize(position);
    // Tangent frame of the sphere: east = direction of increasing longitude
    vec3 east = vec3(n.z, 0.0, -n.x);
    float len = length(east);
    east = len > 1e-4 ? east / len : vec3(1.0, 0.0, 0.0);
    mat3 rot = mat3(modelMatrix);
    vNormalW = normalize(rot * n);
    vSphereW = vNormalW;
    vEastW = normalize(rot * east);
    vNorthW = cross(vNormalW, vEastW);
  #endif

    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mvPos.xyz;
    gl_Position = projectionMatrix * mvPos;
  }
`;

export const earthFragment = /* glsl */ `
  uniform sampler2D uDayMap;
  uniform sampler2D uNightMap;
  uniform sampler2D uNormalMap;
  uniform sampler2D uSpecMap;
  uniform sampler2D uCloudMap;
  uniform sampler2D uHighlightMap;
  uniform float uHasNight;
  uniform float uHasNormal;
  uniform float uHasSpec;
  uniform float uHasClouds;

  uniform vec3 uSunDir;
  uniform float uSunIntensity;
  uniform float uAmbient;
  uniform float uRealistic;     // 1 = sun lighting, 0 = evenly lit globe
  uniform float uSurface;       // 1 = imagery, 0 = holographic grid ("Earth" layer off)
  uniform float uNightLights;   // night lights layer (0..1)
  uniform float uNightAmbient;  // how much of the surface is visible on the night side
  uniform float uLightsGain;    // city lights brightness
  uniform float uNormalScale;
  uniform float uSpecular;
  uniform float uAtmosphere;    // atmosphere layer (0..1), adds rim haze
  uniform vec3 uAtmoColor;
  uniform float uCloudShadow;
  uniform float uCloudOffset;   // cloud layer rotation relative to the surface (in UV units)
  uniform vec3 uHoverColor;
  uniform vec3 uSelectColor;
  uniform float uPulse;
  uniform float uHighlightStrength; // fades the country tint out at street level
  uniform float uTileBlend;         // 0 = built-in texture, 1 = streamed imagery
  uniform float uMapLabels;         // map label overlay visibility
  uniform float uLightsFade;        // the 4K night-lights map is too coarse for close-ups
  uniform float uCloseNight;        // faint "moonlight" so the ground stays readable at night when zoomed in

  // Explosions (flight mode). Positions are camera-relative (view space), in Earth radii.
  uniform float uBlastActive;       // 0 = no explosion anywhere: both loops are skipped
  uniform vec4 uBlastPos[4];        // xyz: light position, w: 1 / light radius
  uniform vec3 uBlastColor[4];      // linear colour × intensity (0 = slot unused)
  uniform vec4 uScorch[8];          // xyz: crater centre, w: 1 / scorch radius
  uniform vec2 uScorchInfo[8];      // x: strength (0 = unused), y: random seed

  #ifdef TILE
    uniform sampler2D uTileMap;
    uniform float uTileMix;         // fade-in of this tile's own image
    uniform sampler2D uParentMap;   // ancestor image shown while loading
    uniform vec4 uParentRect;       // offset.xy, scale.zw of this tile inside the ancestor
    uniform float uHasParent;
    uniform sampler2D uOverlayMap;  // place names / boundaries (transparent PNG)
    uniform vec4 uOverlayRect;
    uniform float uOverlayMix;
    uniform float uSpecScale;
    varying vec2 vTileUv;
  #endif

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vSphereW;
  varying vec3 vEastW;
  varying vec3 vNorthW;
  varying vec3 vPosW;
  varying vec3 vViewPos;

  float cloudDensity(vec4 c) { return c.a * max(max(c.r, c.g), c.b); }

  ${NOISE}

  // Burnt ground around a bomb crater: charred area with ragged edges, radial ejecta
  // streaks, a lighter rim of thrown-up earth and the dark pit itself.
  vec3 applyScorch(vec3 albedo) {
    for (int i = 0; i < 8; i++) {
      float strength = uScorchInfo[i].x;
      if (strength <= 0.0) continue;
      vec3 rel = (vViewPos - uScorch[i].xyz) * uScorch[i].w;
      float d = length(rel);
      if (d > 1.45) continue;
      vec3 relW = (vec4(rel, 0.0) * viewMatrix).xyz; // world-aligned: the pattern stays put
      vec3 q = relW + uScorchInfo[i].y;
      float n1 = vnoise(q * 4.0);
      float n2 = vnoise(q * 11.0);
      float n3 = vnoise(q * 31.0);
      float burn = 1.0 - smoothstep(0.3, 1.0, d + (n1 - 0.5) * 0.6 + (n2 - 0.5) * 0.25);
      float rays = vnoise(normalize(relW + 1e-6) * 6.5 + uScorchInfo[i].y); // constant along each ray
      burn = max(burn, smoothstep(0.58, 0.82, rays) * (1.0 - smoothstep(0.35, 1.4, d + (n2 - 0.5) * 0.2)) * 0.75);
      float rim = smoothstep(0.13, 0.2, d) * (1.0 - smoothstep(0.2, 0.34, d + (n1 - 0.5) * 0.12));
      float pit = 1.0 - smoothstep(0.1, 0.17, d + (n2 - 0.5) * 0.06);
      vec3 charred = vec3(0.03, 0.026, 0.022) * (0.55 + 0.9 * n3);
      albedo = mix(albedo, charred, clamp(burn, 0.0, 1.0) * strength * 0.93);
      albedo = mix(albedo, vec3(0.15, 0.115, 0.085) * (0.7 + 0.6 * n3), rim * strength * 0.6);
      albedo = mix(albedo, vec3(0.02, 0.017, 0.014), pit * strength);
    }
    return albedo;
  }

  // Light of fireballs and fires on the surrounding ground
  vec3 blastLight(vec3 n) {
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      vec3 c = uBlastColor[i];
      if (c.r + c.g + c.b <= 0.0) continue;
      vec3 L = (uBlastPos[i].xyz - vViewPos) * uBlastPos[i].w;
      float d = length(L);
      if (d >= 1.0) continue;
      vec3 Lw = (vec4(L, 0.0) * viewMatrix).xyz / max(d, 1e-5);
      float ndl = clamp(dot(n, Lw) * 0.6 + 0.4, 0.0, 1.0); // wrapped: the terrain normals are coarse
      float window = (1.0 - d * d) * (1.0 - d * d);
      sum += c * ndl * window / (1.0 + 18.0 * d * d);
    }
    return sum;
  }

  void main() {
    vec3 nGeo = normalize(vSphereW);

  #ifdef TILE
    vec3 n = normalize(vNormalW);
    vec3 base = texture2D(uDayMap, vUv).rgb;
    vec3 coarse = uHasParent > 0.5 ? texture2D(uParentMap, vTileUv * uParentRect.zw + uParentRect.xy).rgb : base;
    vec3 day = mix(coarse, texture2D(uTileMap, vTileUv).rgb, uTileMix);
    day = mix(base, day, uTileBlend);
    float specScale = uSpecScale;
  #else
    vec3 n = nGeo;
    if (uHasNormal > 0.5) {
      vec3 m = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0;
      m.xy *= uNormalScale;
      n = normalize(normalize(vEastW) * m.x + normalize(vNorthW) * m.y + nGeo * m.z);
    }
    vec3 day = texture2D(uDayMap, vUv).rgb;
    float specScale = 1.0;
  #endif

    if (uBlastActive > 0.5) day = applyScorch(day);

    vec3 viewDir = normalize(cameraPosition - vPosW);

    // --- Sun lighting -------------------------------------------------
    float cosSun = dot(nGeo, uSunDir);
    float dayMix = smoothstep(-0.08, 0.22, cosSun);          // soft terminator
    float diffuse = max(dot(n, uSunDir), 0.0);

    float shadow = 0.0;
    if (uHasClouds > 0.5 && uCloudShadow > 0.0) {
      shadow = cloudDensity(texture2D(uCloudMap, vec2(vUv.x - uCloudOffset, vUv.y))) * uCloudShadow;
    }

    vec3 lit = day * (uAmbient + diffuse * uSunIntensity * (1.0 - 0.45 * shadow));

    // Sun glint on oceans (specular mask = water)
    float water = uHasSpec > 0.5 ? texture2D(uSpecMap, vUv).r * specScale : 0.0;
    vec3 halfDir = normalize(uSunDir + viewDir);
    float spec = pow(max(dot(nGeo, halfDir), 0.0), 70.0) * water * uSpecular * (1.0 - shadow);
    lit += vec3(1.0, 0.93, 0.82) * spec * smoothstep(0.0, 0.15, cosSun);

    // Warm tint in the twilight band
    float twilight = 1.0 - smoothstep(0.0, 0.3, abs(cosSun + 0.02));
    lit *= mix(vec3(1.0), vec3(1.25, 0.82, 0.62), twilight * 0.55);

    vec3 color = mix(day * (uNightAmbient + uCloseNight), lit, dayMix);

    // City lights appear only once the Sun is below the horizon
    vec3 lights = uHasNight > 0.5 ? texture2D(uNightMap, vUv).rgb : vec3(0.0);
    float lightsMix = 1.0 - smoothstep(-0.22, 0.04, cosSun);
    color += lights * uLightsGain * uNightLights * uLightsFade * lightsMix * (1.0 - 0.5 * shadow) * uSurface;

    // Non-realistic mode: evenly lit globe
    float flatShade = 0.62 + 0.38 * max(dot(n, viewDir), 0.0);
    color = mix(day * flatShade, color, uRealistic);

    if (uBlastActive > 0.5) color += day * blastLight(n) * uSurface;

    // Earth layer off: holographic latitude/longitude grid (15 deg cells)
    vec2 grid = vec2(vUv.x * 24.0, vUv.y * 12.0);
    vec2 gd = abs(fract(grid - 0.5) - 0.5) / fwidth(grid);
    float line = 1.0 - min(min(gd.x, gd.y), 1.0);
    float rim = pow(1.0 - max(dot(nGeo, viewDir), 0.0), 2.0);
    vec3 holo = vec3(0.008, 0.02, 0.045) + vec3(0.06, 0.3, 0.55) * line * 0.55 + vec3(0.08, 0.35, 0.75) * rim * 0.4;
    color = mix(holo, color, uSurface);

    // Hover (red channel) and selection (green channel) masks
    vec4 hl = texture2D(uHighlightMap, vUv) * uHighlightStrength;
    color = mix(color, color * 0.55 + uHoverColor * 0.32, hl.r * 0.6);
    color = mix(color, color * 0.45 + uSelectColor * (0.36 + 0.14 * uPulse), hl.g * 0.72);

  #ifdef TILE
    // Map labels are not lit by the sun, so they stay readable at night
    vec4 ov = texture2D(uOverlayMap, vTileUv * uOverlayRect.zw + uOverlayRect.xy);
    color = mix(color, ov.rgb, ov.a * uOverlayMix * uMapLabels * uTileBlend);
  #endif

    // Atmospheric haze towards the limb / horizon
    float fresnel = pow(1.0 - max(dot(nGeo, viewDir), 0.0), 3.0);
    float atmoLight = mix(1.0, 0.12 + 0.88 * smoothstep(-0.3, 0.45, cosSun), uRealistic);
    color += uAtmoColor * fresnel * atmoLight * uAtmosphere * 0.85;

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* Atmosphere: back-side shell rendered additively                     */
/* ------------------------------------------------------------------ */

export const atmosphereVertex = /* glsl */ `
  varying vec3 vPosW;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vPosW = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

export const atmosphereFragment = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uColor;
  uniform vec3 uTwilightColor;
  uniform float uRealistic;
  uniform float uIntensity;
  uniform float uVisible;
  uniform float uShellRadius;
  varying vec3 vPosW;

  void main() {
    // Closest point of the view ray (from the camera onwards) to the Earth centre.
    // Works from space (limb glow) and from inside the shell (sky colour near the ground).
    vec3 rayDir = normalize(vPosW - cameraPosition);
    float s = max(dot(-cameraPosition, rayDir), 0.0);
    vec3 closest = cameraPosition + rayDir * s;
    float b = length(closest);
    float t = clamp((b - 1.0) / (uShellRadius - 1.0), 0.0, 1.0);   // 0 at the ground, 1 at the shell edge
    float glow = pow(1.0 - t, 2.6);

    float sun = dot(closest / max(b, 1e-4), uSunDir);
    float light = mix(1.0, 0.16 + 0.84 * smoothstep(-0.35, 0.3, sun), uRealistic);
    // Warm band only on the sunward edge of the terminator (avoids a pink/magenta mix on the night side)
    float twilight = (1.0 - smoothstep(0.0, 0.3, abs(sun - 0.05))) * uRealistic;
    vec3 col = mix(uColor, uTwilightColor, twilight * 0.2);

    gl_FragColor = vec4(col * glow * light * uIntensity * uVisible, 1.0);
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* Clouds                                                              */
/* ------------------------------------------------------------------ */

export const cloudsVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normalize(position));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const cloudsFragment = /* glsl */ `
  uniform sampler2D uCloudMap;
  uniform vec3 uSunDir;
  uniform float uRealistic;
  uniform float uOpacity;
  uniform float uRangeFade;   // clouds fade away when zooming in to street level
  varying vec2 vUv;
  varying vec3 vNormalW;

  void main() {
    vec4 c = texture2D(uCloudMap, vUv);
    float density = smoothstep(0.06, 0.85, c.a * max(max(c.r, c.g), c.b));

    float cosSun = dot(normalize(vNormalW), uSunDir);
    float dayMix = smoothstep(-0.12, 0.2, cosSun);
    vec3 col = vec3(0.05 + max(cosSun, 0.0) * 1.05);
    float twilight = 1.0 - smoothstep(0.0, 0.3, abs(cosSun));
    col *= mix(vec3(1.0), vec3(1.2, 0.78, 0.55), twilight * 0.6);
    col = mix(vec3(0.92), col, uRealistic);

    float alpha = density * uOpacity * uRangeFade * mix(1.0, mix(0.28, 0.95, dayMix), uRealistic);
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* Stars (background pass)                                             */
/* ------------------------------------------------------------------ */

export const starsVertex = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vTwinkle;

  void main() {
    vColor = aColor;
    vTwinkle = 0.78 + 0.22 * sin(uTime * (0.6 + aPhase * 1.4) + aPhase * 6.2831);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio;
  }
`;

export const starsFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vTwinkle;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = pow(1.0 - smoothstep(0.0, 0.5, d), 1.8);
    gl_FragColor = vec4(vColor * vTwinkle, a);
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* Lines drawn on the globe (borders, outlines, terminator)            */
/* Drawn without depth test so mountains never hide them; the far      */
/* side of the planet is removed with an exact horizon test instead.   */
/* ------------------------------------------------------------------ */

export const overlayLineVertex = /* glsl */ `
  varying float vFacing;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vFacing = dot(normalize(worldPos.xyz), normalize(cameraPosition - worldPos.xyz));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const overlayLineFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uFacingFade;
  varying float vFacing;
  void main() {
    if (vFacing <= 0.0) discard;
    gl_FragColor = vec4(uColor, uOpacity * smoothstep(0.0, uFacingFade, vFacing));
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* City markers (one draw call for every city)                         */
/* ------------------------------------------------------------------ */

export const markersVertex = /* glsl */ `
  attribute float aRank;
  attribute float aSize;
  attribute float aIndex;
  attribute vec3 aColor;
  uniform float uMaxRank;
  uniform float uSelected;
  uniform float uHovered;
  uniform float uPixelRatio;
  uniform float uScale;
  varying vec3 vColor;
  varying float vState;
  varying float vFacing;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vec3 n = normalize(worldPos.xyz);
    vFacing = dot(n, normalize(cameraPosition - worldPos.xyz));

    bool selected = abs(aIndex - uSelected) < 0.5;
    bool hovered = abs(aIndex - uHovered) < 0.5;
    bool visible = aRank <= uMaxRank || selected || hovered;

    vState = selected ? 2.0 : (hovered ? 1.0 : 0.0);
    vColor = aColor;
    float size = aSize * uScale * (selected ? 1.9 : (hovered ? 1.5 : 1.0));
    gl_PointSize = visible ? size * uPixelRatio : 0.0;
    gl_Position = visible ? projectionMatrix * modelViewMatrix * vec4(position, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

export const markersFragment = /* glsl */ `
  uniform vec3 uSelectedColor;
  uniform vec3 uHoverColor;
  uniform float uFacingFade;
  varying vec3 vColor;
  varying float vState;
  varying float vFacing;

  void main() {
    if (vFacing <= 0.0) discard;
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = 1.0 - smoothstep(0.32, 0.46, d);
    float ring = smoothstep(0.6, 0.7, d) * (1.0 - smoothstep(0.86, 1.0, d));
    float halo = (1.0 - d) * 0.25;

    vec3 col = vColor;
    if (vState > 1.5) col = uSelectedColor;
    else if (vState > 0.5) col = uHoverColor;

    float alpha = max(core, ring * 0.85) + halo;
    alpha *= smoothstep(0.0, uFacingFade, vFacing);   // fade out towards the horizon
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;

/* ================================================================== */
/* Flight mode: explosions, afterburner                                */
/* These write premultiplied colour (blend ONE, ONE_MINUS_SRC_ALPHA), so a single     */
/* sorted particle buffer can mix glowing fire (alpha ≈ 0) and opaque smoke.          */
/* ================================================================== */

/* ---- Particle texture atlas, rendered once on the GPU -------------------------- */
/* 4 × 4 frames · rg: normal xy · b: detail · a: density                             */
/*   0-7 smoke puffs (clusters of billows) · 8-11 flames · 12-13 rock fragments      */
/*   14 soft glow · 15 flare                                                         */
export const atlasVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const atlasFragment = /* glsl */ `
  uniform float uGrid;
  varying vec2 vUv;
  ${NOISE}

  // A smoke puff: the highest of several round billows (the creases between them give
  // the cauliflower look once lit), plus fine turbulence
  float puffHeight(vec2 p, float seed) {
    float h = 0.0;
    for (int i = 0; i < 9; i++) {
      float fi = float(i);
      vec3 r = vec3(hash13(vec3(seed, fi, 1.7)), hash13(vec3(seed, fi, 5.3)), hash13(vec3(seed, fi, 9.1)));
      float rad = 0.2 + 0.2 * r.z;
      vec2 c = (r.xy * 2.0 - 1.0) * (0.66 - rad);
      float d = length(p - c) / rad;
      h = max(h, sqrt(max(1.0 - d * d, 0.0)) * rad);
    }
    return h;
  }

  float field(vec2 p, float frame, out float aux) {
    if (frame < 7.5) {
      float h = puffHeight(p, frame + 1.0);
      float t = fbm(vec3(p * 4.5, frame * 3.7), 5);
      aux = t;
      return h + (t - 0.5) * 0.09 * smoothstep(0.0, 0.07, h);
    }
    if (frame < 11.5) {
      vec3 q = vec3(p.x * 2.3, p.y * 1.5, frame * 5.3);
      float t = fbm(q, 5);
      float turb = abs(gnoise(q * 2.2)) + 0.5 * abs(gnoise(q * 4.7));
      float r = length(p * vec2(1.0, 0.82));
      aux = t;
      return max(0.0, 0.62 - r + (t - 0.5) * 0.75 - turb * 0.28);
    }
    if (frame < 13.5) {
      float r = length(p);
      vec2 dir = p / max(r, 1e-4);
      float edge = 0.36 + 0.13 * gnoise(vec3(dir * 1.8, frame * 9.1)) + 0.05 * gnoise(vec3(dir * 5.0, frame));
      aux = fbm(vec3(p * 6.0, frame * 2.3), 3);
      float k = r / edge;
      return sqrt(max(1.0 - k * k, 0.0)) * edge + (aux - 0.5) * 0.06 * step(r, edge);
    }
    aux = 1.0;
    float r = length(p);
    if (frame < 14.5) return exp(-r * r * 6.0);
    float rays = exp(-abs(p.x) * 45.0) * (1.0 - smoothstep(0.0, 0.95, abs(p.y)))
               + exp(-abs(p.y) * 45.0) * (1.0 - smoothstep(0.0, 0.95, abs(p.x)));
    return exp(-r * r * 10.0) + rays * 0.4;
  }

  void main() {
    vec2 cell = floor(vUv * uGrid);
    vec2 p = fract(vUv * uGrid) * 2.0 - 1.0;
    float frame = cell.x + cell.y * uGrid;
    float aux;
    float unused;
    float e = 2.0 / 256.0;
    float h = field(p, frame, aux);
    float hx = field(p + vec2(e, 0.0), frame, unused);
    float hy = field(p + vec2(0.0, e), frame, unused);
    vec2 grad = vec2(hx - h, hy - h) / e;

    float alpha;
    float bump;
    if (frame < 7.5) { alpha = smoothstep(0.0, 0.085, h) * (0.72 + 0.4 * aux); bump = 1.5; }
    else if (frame < 11.5) { alpha = smoothstep(0.0, 0.28, h); bump = 0.45; }
    else if (frame < 13.5) { alpha = smoothstep(0.0, 0.015, h); bump = 2.2; }
    else { alpha = clamp(h, 0.0, 1.0); bump = 0.0; }
    alpha *= 1.0 - smoothstep(0.86, 0.98, max(abs(p.x), abs(p.y))); // empty frame borders (no bleeding)

    vec3 n = normalize(vec3(-grad * bump, 1.0));
    gl_FragColor = vec4(n.xy * 0.5 + 0.5, aux, clamp(alpha, 0.0, 1.0));
  }
`;

/* ---- Smoke, dust, fire, debris, flash: camera-facing sprites --------------------- */
export const particleVertex = /* glsl */ `
  attribute vec3 iPos;    // centre, metres in the explosion's local frame (+Y up)
  attribute vec4 iShape;  // x: size (m), y: rotation (rad), z: atlas frame
  attribute vec4 iColor;  // rgb: albedo (linear), a: opacity
  attribute vec4 iEmit;   // rgb: emitted light (linear, may exceed 1), a: fire light from below
  uniform float uMetre;   // world units per metre
  uniform float uGrid;    // atlas frames per side
  varying vec2 vUv;
  varying vec2 vRot;
  varying vec4 vColor;
  varying vec4 vEmit;
  varying float vFade;

  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    float size = iShape.x * uMetre;
    float dist = length(mv.xyz);
    // Pull big sprites towards the camera so they cut less into the terrain behind them
    mv.xyz -= mv.xyz / max(dist, 1e-12) * min(size * 0.3, dist * 0.5);
    float c = cos(iShape.y);
    float s = sin(iShape.y);
    vec2 corner = position.xy;
    mv.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
    float frame = floor(iShape.z + 0.5);
    vec2 cell = vec2(mod(frame, uGrid), floor(frame / uGrid));
    vUv = (cell + corner + 0.5) / uGrid;
    vRot = vec2(c, s);
    vColor = iColor;
    vEmit = iEmit;
    // Sprites that fill the screen (camera inside the cloud) fade out
    vFade = smoothstep(0.3, 1.2, dist / max(size, 1e-12));
    gl_Position = projectionMatrix * mv;
  }
`;

export const particleFragment = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform vec3 uSunView;    // direction to the Sun (view space)
  uniform vec3 uSunColor;   // sunlight reaching the cloud (0 at night)
  uniform vec3 uAmbient;    // sky light
  uniform vec3 uUpView;     // local up (view space)
  varying vec2 vUv;
  varying vec2 vRot;
  varying vec4 vColor;
  varying vec4 vEmit;
  varying float vFade;
  ${TO_SRGB}

  void main() {
    vec4 t = texture2D(uAtlas, vUv);
    float cover = t.a * vFade;
    float alpha = cover * vColor.a;
    vec3 emit = vEmit.rgb * (0.5 + 0.7 * t.b);
    if (alpha < 0.002 && cover * dot(emit, vec3(1.0)) < 0.004) discard;

    // Billow normals from the atlas, rotated with the sprite
    vec2 nxy = t.rg * 2.0 - 1.0;
    nxy = vec2(vRot.x * nxy.x - vRot.y * nxy.y, vRot.y * nxy.x + vRot.x * nxy.y);
    vec3 n = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
    float up = dot(n, uUpView);
    float sun = smoothstep(-0.4, 1.0, dot(n, uSunView));
    vec3 light = uAmbient * (0.62 + 0.38 * up)
               + uSunColor * sun * (0.7 + 0.3 * t.b)
               + vec3(1.0, 0.4, 0.1) * vEmit.a * (0.45 + 0.55 * max(-up, 0.0));
    gl_FragColor = vec4(toSRGB(vColor.rgb * light) * alpha + toSRGB(emit) * cover, alpha);
  }
`;

/* ---- Sparks: glowing fragments stretched along their velocity ------------------- */
export const sparkVertex = /* glsl */ `
  attribute vec3 iPos;    // head (m)
  attribute vec3 iVel;    // velocity (m/s)
  attribute vec4 iData;   // x: width (m), y: streak length (s), z: temperature 0..1, w: brightness
  uniform float uMetre;
  varying float vAcross;
  varying float vAlong;
  varying vec3 vColor;

  vec3 sparkColor(float t) {
    vec3 c = mix(vec3(1.0, 0.22, 0.03), vec3(1.0, 0.62, 0.18), smoothstep(0.2, 0.6, t));
    return mix(c, vec3(1.0, 0.95, 0.82), smoothstep(0.65, 1.0, t));
  }

  void main() {
    vec3 head = (modelViewMatrix * vec4(iPos, 1.0)).xyz;
    vec3 tail = (modelViewMatrix * vec4(iPos - iVel * iData.y, 1.0)).xyz;
    float width = iData.x * uMetre;
    vec3 axis = tail - head;
    if (length(axis) < width * 2.0) axis = normalize(axis + vec3(0.0, -1e-9, 0.0)) * width * 2.0;
    vec3 side = cross(normalize(axis), normalize(head + axis * 0.5));
    side = length(side) > 1e-4 ? normalize(side) : vec3(1.0, 0.0, 0.0);
    vec3 p = head + axis * (position.y + 0.5) + side * width * position.x * 2.0;
    vAcross = position.x * 2.0;
    vAlong = position.y + 0.5;
    vColor = sparkColor(iData.z) * iData.w;
    gl_Position = projectionMatrix * vec4(p, 1.0);
  }
`;

export const sparkFragment = /* glsl */ `
  varying float vAcross;
  varying float vAlong;
  varying vec3 vColor;
  ${TO_SRGB}
  void main() {
    float a = (1.0 - vAcross * vAcross) * (1.0 - vAlong * 0.9);
    gl_FragColor = vec4(toSRGB(vColor) * a, 0.0);
  }
`;

/* ---- Fireball: noise-displaced sphere, coloured by temperature ------------------ */
export const fireballVertex = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uTurb;    // surface displacement (fraction of the radius)
  varying vec3 vDir;
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  varying float vBump;
  ${NOISE}
  void main() {
    vec3 dir = normalize(position);
    vec3 q = dir * 1.9 + vec3(0.0, -uTime * 0.55, 0.0) + uSeed;
    float n = fbm(q, 3);
    float n2 = fbm(q * 2.3 + 5.0, 2);
    float disp = ((n - 0.5) * 1.4 + (n2 - 0.5) * 0.5) * uTurb;
    vBump = n;
    vDir = dir;
    vec4 mv = modelViewMatrix * vec4(position * (1.0 + disp), 1.0);
    vViewPos = mv.xyz;
    vNormalV = normalize(normalMatrix * dir);
    gl_Position = projectionMatrix * mv;
  }
`;

export const fireballFragment = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uHeat;      // 1 white hot … 0 cold soot
  uniform float uOpacity;
  uniform vec3 uSunView;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform vec3 uUpView;
  varying vec3 vDir;
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  varying float vBump;
  ${NOISE}
  ${TO_SRGB}

  vec3 fireRamp(float t) {
    vec3 c = mix(vec3(0.0), vec3(0.3, 0.03, 0.005), smoothstep(0.0, 0.25, t));
    c = mix(c, vec3(1.0, 0.25, 0.02), smoothstep(0.22, 0.5, t));
    c = mix(c, vec3(1.0, 0.6, 0.15), smoothstep(0.45, 0.72, t));
    return mix(c, vec3(1.0, 0.93, 0.72), smoothstep(0.7, 1.0, t));
  }

  void main() {
    vec3 V = normalize(-vViewPos);
    vec3 N = normalize(vNormalV);
    float facing = max(dot(N, V), 0.0);
    vec3 q = vDir * 4.2 + vec3(0.0, -uTime * 1.1, 0.0) + uSeed * 1.7;
    float detail = fbm(q, 4);
    float cells = fbm(q * 2.6, 2);
    // Hottest where the view crosses the most fire; turbulent cooler patches everywhere
    float temp = uHeat * (0.25 + 0.95 * pow(facing, 0.6))
               + (detail - 0.5) * 0.9 * (0.25 + uHeat)
               + (vBump - 0.5) * 0.5 * uHeat;
    temp = clamp(temp - (1.0 - cells) * 0.12, 0.0, 1.0);
    float glow = smoothstep(0.05, 0.3, temp);
    vec3 emit = fireRamp(temp) * (0.35 + 2.2 * smoothstep(0.25, 0.95, temp));
    vec3 soot = vec3(0.045, 0.04, 0.036)
              * (uAmbient * (0.7 + 0.3 * dot(N, uUpView)) + uSunColor * smoothstep(-0.3, 1.0, dot(N, uSunView)));
    float alpha = uOpacity * smoothstep(0.0, 0.45, facing + (detail - 0.5) * 0.5);
    gl_FragColor = vec4((toSRGB(soot) * (1.0 - glow) + toSRGB(emit) * glow) * alpha, alpha * (1.0 - 0.5 * glow));
  }
`;

/* ---- Shock wave: faint expanding shell ------------------------------------------ */
export const shockVertex = /* glsl */ `
  varying float vFacing;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normalize(position));
    vFacing = abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`;

export const shockFragment = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uColor;
  varying float vFacing;
  ${TO_SRGB}
  void main() {
    float a = pow(1.0 - vFacing, 4.0) * uOpacity;
    gl_FragColor = vec4(toSRGB(uColor) * a, a * 0.5);
  }
`;

/* ---- Afterburner plume with shock diamonds --------------------------------------- */
export const flameVertex = /* glsl */ `
  varying float vAlong;
  varying float vFacing;
  void main() {
    vAlong = position.z;   // the geometry runs from z = 0 (nozzle) to z = 1 (tip)
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vFacing = abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`;

export const flameFragment = /* glsl */ `
  uniform float uTime;
  uniform float uPower;     // 0 idle … 1 full afterburner
  uniform vec3 uColorA;     // at the nozzle
  uniform vec3 uColorB;     // towards the tip
  uniform float uDiamonds;  // number of shock diamonds
  varying float vAlong;
  varying float vFacing;
  ${TO_SRGB}
  void main() {
    float x = clamp(vAlong, 0.0, 1.0);
    float body = pow(vFacing, 1.6);
    float diamonds = 1.0 + 0.6 * pow(0.5 + 0.5 * cos(x * 6.2831 * uDiamonds), 6.0) * (1.0 - smoothstep(0.3, 0.75, x));
    float flicker = 0.84 + 0.16 * sin(uTime * 71.0 + x * 23.0) * sin(uTime * 37.0 - x * 11.0);
    float a = pow(1.0 - x, 1.7) * body * diamonds * flicker * uPower;
    vec3 col = mix(uColorA, uColorB, smoothstep(0.05, 0.7, x));
    gl_FragColor = vec4(toSRGB(col * a), 0.0);
  }
`;
