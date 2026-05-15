'use strict';

const canvas = document.getElementsByTagName('canvas')[0];
canvas.width = canvas.clientWidth;
canvas.height = canvas.clientHeight;

function getWebGLContext(canvas) {
    const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };

    let gl = canvas.getContext('webgl2', params);
    const isWebGL2 = !!gl;
    if (!isWebGL2)
        gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);

    let halfFloat;
    let supportLinearFiltering;
    if (isWebGL2) {
        gl.getExtension('EXT_color_buffer_float');
        supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
    } else {
        halfFloat = gl.getExtension('OES_texture_half_float');
        supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
    }

    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
    let formatRGBA;
    let formatRG;
    let formatR;

    if (isWebGL2) {
        formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
        formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
        formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
    }
    else {
        formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }

    return {
        gl,
        ext: {
            formatRGBA,
            formatRG,
            formatR,
            halfFloatTexType,
            supportLinearFiltering
        }
    };
}

function getSupportedFormat(gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
        switch (internalFormat) {
            case gl.R16F:
                return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
            case gl.RG16F:
                return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
            default:
                return null;
        }
    }

    return {
        internalFormat,
        format
    }
}

function supportRenderTextureFormat(gl, internalFormat, format, type) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status != gl.FRAMEBUFFER_COMPLETE)
        return false;
    return true;
}

const { gl, ext } = getWebGLContext(canvas);

/***************************************************/
/*              Compiling the shaders              */
/***************************************************/

function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw gl.getShaderInfoLog(shader);

    return shader;
}

class GLProgram {
    constructor(vertexShader, fragmentShader) {
        this.uniforms = {};
        this.program = gl.createProgram();

        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
            throw gl.getProgramInfoLog(this.program);

        const uniformCount = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < uniformCount; i++) {
            const uniformName = gl.getActiveUniform(this.program, i).name;
            this.uniforms[uniformName] = gl.getUniformLocation(this.program, uniformName);
        }
    }

    bind() {
        gl.useProgram(this.program);
    }
}

const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
precision highp float;

attribute vec2 aPosition;
varying vec2 v_Texcoord;
varying vec2 v_TexcoordFlipped;

void main () {
    v_Texcoord = aPosition * 0.5 + 0.5;
    v_TexcoordFlipped = v_Texcoord;
    v_TexcoordFlipped.y = 1.0 - v_Texcoord.y;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`);

const valueShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_TexcoordFlipped;
uniform sampler2D u_banner;
uniform float u_widthFactor;
uniform float u_xOffset;

void main () {
    vec2 uv = v_TexcoordFlipped;
    uv.x = uv.x * u_widthFactor - u_xOffset;
    vec4 banner = texture2D(u_banner, uv );
    float value = (banner.r * 0.2126 + banner.g * 0.7152 + banner.b * 0.0722) * banner.a;
    gl_FragColor = vec4(value, value, 1.0, 1.0);
}
`);

const valueFadeEffectShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_Texcoord;
varying vec2 v_TexcoordFlipped;
uniform sampler2D u_previous;
uniform sampler2D u_UVMap;
uniform vec2 u_texel;
uniform float u_subtract;
uniform int u_rainDir; // neg = rotate, 1 = flip, 2 = mix

float rand(vec2 co){
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

float getDist(int dir, float rainSeed, float texel)
{
    if(dir == 1 || (dir == 2 && rand(vec2(rainSeed, -rainSeed)) > 0.5))
        return -texel;
    return texel;
}

void main () {

    vec2 values = texture2D(u_previous, v_Texcoord).rg;
    vec2 seed = texture2D(u_UVMap, v_TexcoordFlipped).zw;

    if(u_rainDir < 0)
    {
        float horizontalUV = v_Texcoord.x - getDist(-u_rainDir, seed.y, u_texel.x);
        if(horizontalUV <= 1.0)
        {
            float newValue = texture2D(u_previous, vec2(horizontalUV, v_Texcoord.y)).g - u_subtract;
            if(newValue > values.y)
                values.y = newValue;
        }
    }
    else
    {
        float verticalUV = v_Texcoord.y + getDist(u_rainDir, seed.x, u_texel.y);
        if(verticalUV <= 1.0)
        {
            float newValue = texture2D(u_previous, vec2(v_Texcoord.x, verticalUV)).g - u_subtract;
            if(newValue > values.y)
                values.y = newValue;
        }
    }

    gl_FragColor = vec4(values.x, values.y, 0, 1.0);
}

`);

const uvShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;

varying vec2 v_Texcoord;
uniform vec2 u_outputDimension;
uniform vec2 u_valueMapTexel;
uniform float u_glyphRenderDimension;
uniform float u_glyphTexel;

// xy = uv for sampling a glyph
// zw = uv for picking a glyph
void main () {

    vec2 pixelUV = v_Texcoord * u_outputDimension;
    float glyphFac = 1.0 / u_glyphRenderDimension;

    vec2 sampleUV = mod(pixelUV, u_glyphRenderDimension) * glyphFac * u_glyphTexel;
    vec2 mapUV = (floor(pixelUV * glyphFac) + 0.5) * u_valueMapTexel;
    mapUV.y = 1.0 - mapUV.y;

    gl_FragColor = vec4(sampleUV, mapUV);
}
`);

const glyphShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_TexcoordFlipped;
uniform sampler2D u_UVMap;
uniform sampler2D u_glyphMap;
uniform sampler2D u_valueMap;
uniform sampler2D u_foreground;

uniform float u_time;

uniform float u_glyphCount;
uniform float u_glyphRowColCount;
uniform float u_glyphChangeRate;
uniform float u_glyphChangeRateRandom;

uniform float u_rainLengthMin;
uniform float u_rainLengthRandom;
uniform float u_rainSpeedMin;
uniform float u_rainSpeedRandom;
uniform float u_rainSpacingMin;
uniform float u_rainSpacingRandom;
uniform int u_rainDir; // neg = rotate, 1 = flip, 2 = mix

uniform float u_valueMin;
uniform float u_valueAdd;
uniform float u_bannerValue;

float rand(vec2 co){
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

vec2 calcRain(float offset, float rainSeed)
{
	// Calculating the size
	float SizeRand = rand(vec2(rainSeed, 2.0));
	float Size = offset / (u_rainLengthMin + u_rainLengthRandom * SizeRand);

	// Calculating the time
	float timeRand = rand(vec2(rainSeed, 10.0));
	float time = u_time / (u_rainSpeedMin + u_rainSpeedRandom * timeRand);

	float rainRaw = Size - time;

	float rainRandom = rand(vec2(rainSeed, floor(rainRaw)));
	float rainSpacing = u_rainSpacingMin + u_rainSpacingRandom * rainRandom;

	float rain =
        max( 0.0,
            (fract(rainRaw) - rainSpacing)
            / (1.0 - rainSpacing));

	return vec2(rain, rainRandom);
}

float calcGlyphTile(vec4 tileUVMap, float rainRandom)
{
	// calculating the tile ID
	vec2 tileMapIDRandom = tileUVMap.zw; // Tile random
	tileMapIDRandom.y += rainRandom; // Per-Rain stripe instance random

	// used to give every tile a different speed
    float flickerRate = u_glyphChangeRate + rand(tileMapIDRandom) * u_glyphChangeRateRandom;
	tileMapIDRandom.x += floor(flickerRate * u_time);

	float tileID = floor(rand(tileMapIDRandom) * u_glyphCount);

	// Calculating the tile offset
	float tileSize = 1.0 / u_glyphRowColCount;
	vec2 tileOffset = vec2(
		tileSize * mod(tileID, u_glyphRowColCount),
		tileSize * floor(tileID / u_glyphRowColCount)
	);

	// Sampling the glyph
	vec2 glyphMap = tileUVMap.xy + tileOffset;

	return texture2D(u_glyphMap, glyphMap).x;
}

vec2 calcColorFactor(vec2 tileMap, float rain)
{
    vec2 bannerFac = texture2D(u_valueMap, tileMap).rg;

    // color
	float colorFac = max(bannerFac.x, rain);

    // brightness
    float fadeMult = u_valueMin + bannerFac.y * u_valueAdd;
    float rainFac = rain * fadeMult;
	float bannerFadeFac = max(rainFac, bannerFac.x * u_bannerValue);

	return vec2(colorFac, bannerFadeFac);
}

void main()
{
    vec4 glyphUV = texture2D(u_UVMap, v_TexcoordFlipped);

    float rainOffset = v_TexcoordFlipped.y;
    float rainSeed = glyphUV.z;
    int rainMode = u_rainDir;

    // do horizontal
    if(u_rainDir < 0)
    {
        rainOffset = v_TexcoordFlipped.x;
        rainSeed = glyphUV.w;
        rainMode = -u_rainDir;
    }

    // flip or mix
    if(rainMode == 1 || (rainMode == 2 && rand(vec2(rainSeed, -rainSeed)) > 0.5))
    {
        rainOffset = -rainOffset;
    }

    vec2 rain = calcRain(rainOffset, rainSeed);


    gl_FragColor.gb = calcColorFactor(glyphUV.zw, rain.x);

    if(gl_FragColor.b > 0.0)
    {
        gl_FragColor.r = calcGlyphTile(glyphUV, rain.y) * gl_FragColor.b;
    }

    float foreground_alpha = texture2D(u_foreground, v_TexcoordFlipped).a;
    gl_FragColor.a = 1.0 - foreground_alpha;


    // r = glyph * value mask
    // g = color index
    // b = value mask
    // a = alpha mask
}

`);

const glyphColorShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_Texcoord;
uniform sampler2D u_texture;
uniform sampler2D u_colorGradient;

void main()
{
    float valueG = texture2D(u_texture, v_Texcoord).g;
    gl_FragColor.rgb = texture2D(u_colorGradient, vec2(valueG, 0.5)).rgb;
}
`);

const glyphColorCAShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_Texcoord;
uniform sampler2D u_texture;
uniform sampler2D u_colorGradient;
uniform vec2 u_offset;

void main()
{
    float valueR = texture2D(u_texture, v_Texcoord - u_offset).g;
    float valueG = texture2D(u_texture, v_Texcoord).g;
    float valueB = texture2D(u_texture, v_Texcoord + u_offset).g;

    gl_FragColor.r = texture2D(u_colorGradient, vec2(valueR, 0.5)).r;
    gl_FragColor.g = texture2D(u_colorGradient, vec2(valueG, 0.5)).g;
    gl_FragColor.b = texture2D(u_colorGradient, vec2(valueB, 0.5)).b;
}
`);

const glyphMaskShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_Texcoord;
uniform sampler2D u_texture;

void main()
{
    vec2 value = texture2D(u_texture, v_Texcoord).ra;
    gl_FragColor.rgb = vec3(value.x * value.y);
}
`);

const glyphMaskCAShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_Texcoord;
uniform sampler2D u_texture;
uniform vec2 u_offset;

void main()
{
    vec2 baseValue = texture2D(u_texture, v_Texcoord).ra;

    float valueR = texture2D(u_texture, v_Texcoord - u_offset).r;
    float valueB = texture2D(u_texture, v_Texcoord + u_offset).r;

    gl_FragColor.r = baseValue.y * valueR;
    gl_FragColor.g = baseValue.y * baseValue.x;
    gl_FragColor.b = baseValue.y * valueB;
}
`);

const gaussianBlurShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_TexcoordFlipped;
uniform sampler2D u_texture;

uniform vec2 u_direction;
uniform vec2 u_texel;

void main()
{
    vec4 color = vec4(0.0);
    vec2 dir = u_direction * u_texel;
    vec2 off1 = 1.411764705882353 * dir;
    vec2 off2 = 3.2941176470588234 * dir;
    vec2 off3 = 5.176470588235294 * dir;

    color += texture2D(u_texture, v_TexcoordFlipped) * 0.1964825501511404;
    color += texture2D(u_texture, v_TexcoordFlipped + off1) * 0.2969069646728344;
    color += texture2D(u_texture, v_TexcoordFlipped - off1) * 0.2969069646728344;
    color += texture2D(u_texture, v_TexcoordFlipped + off2) * 0.09447039785044732;
    color += texture2D(u_texture, v_TexcoordFlipped - off2) * 0.09447039785044732;
    color += texture2D(u_texture, v_TexcoordFlipped + off3) * 0.010381362401148057;
    color += texture2D(u_texture, v_TexcoordFlipped - off3) * 0.010381362401148057;
    gl_FragColor = color;
}
`);

const noiseVertexShader = compileShader(gl.VERTEX_SHADER, `
precision highp float;

attribute vec2 aPosition;
varying vec2 v_Texcoord;
varying vec4 v_TexCoordNoise;

uniform float u_time;
uniform float u_aspect;

uniform float u_noiseScale;

void main () {
    v_Texcoord = aPosition * 0.5 + 0.5;

    float t = fract(u_time);
	v_TexCoordNoise.xy = (v_Texcoord.xy + t) * u_noiseScale;
	v_TexCoordNoise.zw = (v_Texcoord.xy - t * 2.5) * u_noiseScale * 0.52;
	v_TexCoordNoise *= vec4(u_aspect, 1.0, u_aspect, 1.0);

    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`);

const noiseFragmentShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_Texcoord;
varying vec4 v_TexCoordNoise;

uniform sampler2D u_texture;
uniform sampler2D u_noise;

uniform float u_noiseExponent;
uniform float u_noiseStrength;

#define BlendSoftLightf(base, blend) ((blend < 0.5) ? (2.0 * base * blend + base * base * (1.0 - 2.0 * blend)) : (sqrt(base) * (2.0 * blend - 1.0) + 2.0 * base * (1.0 - blend)))
#define BlendSoftLight(base, blend) vec3(BlendSoftLightf(base.r, blend.r), BlendSoftLightf(base.g, blend.g), BlendSoftLightf(base.b, blend.b))

void main()
{
    vec4 base = texture2D(u_texture, v_Texcoord);

    vec3 noise = texture2D(u_noise, v_TexCoordNoise.xy).rgb;
	vec3 noise2 = texture2D(u_noise, v_TexCoordNoise.zw).gbr;

    noise = clamp(noise * noise2, 0.0, 1.0);
	noise = pow(noise, vec3(u_noiseExponent));

    vec3 color = mix(base.rgb, BlendSoftLight(base.rgb, noise), u_noiseStrength);
    gl_FragColor = vec4(color, base.a);
}
`);

const compileGlyphShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_Texcoord;

uniform sampler2D u_glyphColor;
uniform sampler2D u_glyphMask;
uniform sampler2D u_add;

void main()
{
    vec3 glyphColor = texture2D(u_glyphColor, v_Texcoord).rgb;
    vec3 glyphMask = texture2D(u_glyphMask, v_Texcoord).rgb;
    vec3 addColor = texture2D(u_add, v_Texcoord).rgb;

    gl_FragColor.rgb = glyphColor * glyphMask + addColor;
}

`)

const detailBloomShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_Texcoord;
varying vec2 v_TexcoordFlipped;
uniform sampler2D u_texture;
uniform sampler2D u_glyph;

uniform vec2 u_direction;
uniform vec2 u_texel;

uniform float u_bloomIntensity;
uniform float u_bloomThreshold;
uniform float u_bloomThresholdFactor;

vec3 sample(vec2 offset, float factor)
{
    vec3 prev = texture2D(u_texture, v_Texcoord + offset).rgb;
    vec3 bloom = texture2D(u_glyph, v_Texcoord + offset).rgb;

    return (prev + bloom) * factor;
}

vec3 bloomColor()
{
    vec3 color = vec3(0.0);
    vec2 dir = u_direction * u_texel;
    vec2 off1 = 1.411764705882353 * dir;
    vec2 off2 = 3.2941176470588234 * dir;
    vec2 off3 = 5.176470588235294 * dir;


    color += sample(vec2(0.0), 0.1964825501511404);
    color += sample(off1, 0.2969069646728344);
    color += sample(-off1, 0.2969069646728344);
    color += sample(off2, 0.09447039785044732);
    color += sample(-off2, 0.09447039785044732);
    color += sample(off3, 0.010381362401148057);
    color += sample(-off3, 0.010381362401148057);

    return color;
}

void main()
{
    vec3 bloom = clamp((bloomColor() - u_bloomThreshold) * u_bloomThresholdFactor, 0.0, 1.0);
    vec3 prev = texture2D(u_texture, v_Texcoord).rgb;
    gl_FragColor.rgb = prev + bloom * u_bloomIntensity;
}
`);

const hdrBloomDownSampleShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_TexcoordFlipped;
uniform sampler2D u_texture;
uniform vec4 u_offsets;
uniform vec4 u_thresholdParams;
uniform float u_intensity;

void main()
{
    vec3 albedo = 0.25 * (
        texture2D(u_texture, v_TexcoordFlipped + u_offsets.xy).rgb +
        texture2D(u_texture, v_TexcoordFlipped + u_offsets.zy).rgb +
        texture2D(u_texture, v_TexcoordFlipped + u_offsets.xw).rgb +
        texture2D(u_texture, v_TexcoordFlipped + u_offsets.zw).rgb);

    float brightness = max(albedo.r, max(albedo.g, albedo.b));
    float soft = brightness - u_thresholdParams.y;
    soft = clamp(soft, 0.0, u_thresholdParams.z);
    soft *= soft * u_thresholdParams.w;
    float contribution = max(soft, brightness - u_thresholdParams.x);
    contribution /= max(brightness, 0.00001);

    gl_FragColor = vec4(albedo * contribution * u_intensity, 1);
}
`);

const hdrBloomUpSampleShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_TexcoordFlipped;
uniform sampler2D u_texture;
uniform vec4 u_offsets;
uniform float u_scatter;

void main()
{
    vec3 albedo =
        texture2D(u_texture, v_TexcoordFlipped + u_offsets.xy).rgb +
        texture2D(u_texture, v_TexcoordFlipped + u_offsets.zy).rgb +
        texture2D(u_texture, v_TexcoordFlipped + u_offsets.xw).rgb +
        texture2D(u_texture, v_TexcoordFlipped + u_offsets.zw).rgb;

    gl_FragColor = vec4(albedo * u_scatter, 1);
}
`);

const hdrBloomCombineShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_Texcoord;
varying vec2 v_TexcoordFlipped;
uniform sampler2D u_texture;
uniform sampler2D u_bloom;
uniform vec4 u_offsets;

void main()
{
    vec3 bloom =
        texture2D(u_bloom, v_TexcoordFlipped + u_offsets.xy).rgb +
        texture2D(u_bloom, v_TexcoordFlipped + u_offsets.zy).rgb +
        texture2D(u_bloom, v_TexcoordFlipped + u_offsets.xw).rgb +
        texture2D(u_bloom, v_TexcoordFlipped + u_offsets.zw).rgb;

    vec3 albedo = texture2D(u_texture, v_Texcoord).rgb;

    gl_FragColor = clamp(vec4(albedo + bloom * 0.25, 1), 0.0, 1.0);
}
`);

const combineBGShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_Texcoord;
varying vec2 v_TexcoordFlipped;

uniform sampler2D u_background;
uniform sampler2D u_foreground;
uniform sampler2D u_glyphColor;
uniform sampler2D u_glyphMask;
uniform sampler2D u_bloom;

void main()
{
    vec3 background = texture2D(u_background, v_TexcoordFlipped).rgb;
    vec4 foreground = texture2D(u_foreground, v_TexcoordFlipped);
    vec3 color = mix(background, foreground.rgb, foreground.a);

    vec3 glyphColor = texture2D(u_glyphColor, v_Texcoord).rgb;
    vec3 glyphMask = texture2D(u_glyphMask, v_Texcoord).rgb;

    color = mix(color, glyphColor, glyphMask);
    color += texture2D(u_bloom, v_Texcoord).rgb;

    gl_FragColor.rgb = color;
}
`);

const debugShader = compileShader(gl.FRAGMENT_SHADER, `
precision highp float;
precision highp sampler2D;

varying vec2 v_Texcoord;
uniform sampler2D u_debug;

void main()
{
    gl_FragColor = texture2D(u_debug, v_Texcoord);
}
`);

const valueProgram = new GLProgram(baseVertexShader, valueShader);
const valueFadeEffectProgram = new GLProgram(baseVertexShader, valueFadeEffectShader);
const uvProgram = new GLProgram(baseVertexShader, uvShader);

const glyphProgram = new GLProgram(baseVertexShader, glyphShader);
const glyphColorProgram = new GLProgram(baseVertexShader, glyphColorShader);
const glyphColorCAProgram = new GLProgram(baseVertexShader, glyphColorCAShader);
const glyphMaskProgram = new GLProgram(baseVertexShader, glyphMaskShader);
const glyphMaskCAProgram = new GLProgram(baseVertexShader, glyphMaskCAShader);
const compileGlyphProgram = new GLProgram(baseVertexShader, compileGlyphShader);

const gaussianBlurProgram = new GLProgram(baseVertexShader, gaussianBlurShader);
const noiseProgram = new GLProgram(noiseVertexShader, noiseFragmentShader);
const detailBloomProgram = new GLProgram(baseVertexShader, detailBloomShader);
const hdrBloomDownSampleProgram = new GLProgram(baseVertexShader, hdrBloomDownSampleShader);
const hdrBloomUpSampleProgram = new GLProgram(baseVertexShader, hdrBloomUpSampleShader);
const hdrBloomCombineProgram = new GLProgram(baseVertexShader, hdrBloomCombineShader);
const combineBGProgram = new GLProgram(baseVertexShader, combineBGShader);
const debugProgram = new GLProgram(baseVertexShader, debugShader);

/***************************************************/
/*              Wallpaper engine handling          */
/***************************************************/

const DEFAULT_SETTINGS = {
    GLYPH_RENDER_DIMENSION: 12, // size to render the glyph on the screen
    CUSTOM_GLYPHMAP_PATH: "",
    GLYPH_COLROW_COUNT: 12, // Column/Row count in glyphmap
    GLYPH_COUNT: 135, // Number of glyphs

    // Randomizer adds ontop
    GLYPH_CHANGERATE: 0.9, // Amount of times to change a glyph in a second
    GLYPH_CHANGERATE_RANDOM: 0.1,
    RAIN_LENGTH: 0.3, // Rain trail length
    RAIN_LENGTH_RANDOM: 0.5,
    RAIN_SPACING: 0, // Amount of space occupied by a rains trail
    RAIN_SPACING_RANDOM: 0.5,
    RAIN_SPEED: 3, // Drop speed of a rain trail
    RAIN_SPEED_RANDOM: 1.5,
    RAIN_DIRMODE: 3, // direction of the rain

    CUSTOM_GRADIENT_PATH: "",
    COLOR_VALUE: 0.3, // minimum brightness based on fade map
    USE_BANNER: true,
    CUSTOM_BANNER_PATH: "",
    BANNER_FADE_DISTANCE: 300, // in pixels
    COLOR_VALUE_FADE: 2, // maximum brightness based on fade map
    COLOR_VALUE_BANNER: 1.2, // banner brightness

    BLUR_RADIUS: 0.15,

    CHROMATIC_SHIFT: 3,
    CHROMATIC_ROTATION: 0,

    USE_NOISE: true,
    NOISE_SCALE: 10,
    NOISE_STRENGTH: 2,
    NOISE_EXPONENT: 0.5,

    USE_DETAILBLOOM: true,
    DETAILBLOOM_RADIUS: 1,
    DETAILBLOOM_INTENSITY: 1,
    DETAILBLOOM_THRESHOLD: 0.3,

    USE_HDRBLOOM: true,
    HDRBLOOM_ITERATIONS: 4,
    HDRBLOOM_INTENSITY: 1.6,
    HDRBLOOM_SCATTER: 0.6,
    HDRBLOOM_THRESHOLD: 0.1,
    HDRBLOOM_SOFTTHRESHOLD: 0.5,

    BACKGROUND_PATH: "",
    FOREGROUND_PATH: ""
}

let settings = {
    ...DEFAULT_SETTINGS,
    glyphmapChanged: true,
    gradientChanged: true,
    bannerChanged: true,
    recalcFBOs: true,
    recalcMaps: true,
    backgroundChanged: true,
    foregroundChanged: true,

    get realGlyphColRowCount() {
        if (this.CUSTOM_GLYPHMAP_PATH != "")
            return this.GLYPH_COLROW_COUNT;
        else
            return DEFAULT_SETTINGS.GLYPH_COLROW_COUNT;
    },

    get realGlyphCount() {
        if (this.CUSTOM_GLYPHMAP_PATH != "")
            return this.GLYPH_COUNT;
        else
            return DEFAULT_SETTINGS.GLYPH_COUNT;
    }
};

window.wallpaperPropertyListener = {
    applyUserProperties: function (properties) {
        const setValue = (property, setting) => {
            if (properties[property]) {
                settings[setting] = properties[property].value;
            }
        }

        const setValueCheck = (property, setting, change) => {
            if (properties[property]
                && settings[setting] != properties[property].value) {
                settings[setting] = properties[property].value;
                settings[change] = true;
            }
        }

        setValueCheck("glyphRenderDimension", "GLYPH_RENDER_DIMENSION", "recalcFBOs");
        setValueCheck("glyphMap", "CUSTOM_GLYPHMAP_PATH", "glyphmapChanged");
        setValueCheck("glyphColRowCount", "GLYPH_COLROW_COUNT", "recalcMaps");
        setValueCheck("glyphCount", "GLYPH_COUNT", "recalcMaps");

        setValue("glyphChangeRateValue", "GLYPH_CHANGERATE");
        setValue("glyphChangeRateRandom", "GLYPH_CHANGERATE_RANDOM");
        setValue("rainLengthValue", "RAIN_LENGTH");
        setValue("rainLengthRandom", "RAIN_LENGTH_RANDOM");
        setValue("rainSpacingValue", "RAIN_SPACING");
        setValue("rainSpacingRandom", "RAIN_SPACING_RANDOM");
        setValue("rainSpeedValue", "RAIN_SPEED");
        setValue("rainSpeedRandom", "RAIN_SPEED_RANDOM");

        if (properties["direction"]) {
            var direction = properties["direction"].value;
            if (direction === "up")
                settings.RAIN_DIRMODE = 1;
            else if (direction == "downup")
                settings.RAIN_DIRMODE = 2;
            else if (direction == "right")
                settings.RAIN_DIRMODE = -3;
            else if (direction == "left")
                settings.RAIN_DIRMODE = -1;
            else if (direction == "rightleft")
                settings.RAIN_DIRMODE = -2;
            else settings.RAIN_DIRMODE = 3;
            settings.recalcMaps = true;
        }

        setValueCheck("customGradient", "CUSTOM_GRADIENT_PATH", "gradientChanged");
        setValue("brightnessMin", "COLOR_VALUE");
        setValueCheck("useBanner", "USE_BANNER", "recalcMaps");
        setValueCheck("customBanner", "CUSTOM_BANNER_PATH", "bannerChanged");
        setValueCheck("fadeLength", "BANNER_FADE_DISTANCE", "recalcMaps");
        setValue("brightnessMax", "COLOR_VALUE_FADE");
        setValue("brightnessBanner", "COLOR_VALUE_BANNER");

        setValue("blur", "BLUR_RADIUS");

        setValue("chromaticAberationShift", "CHROMATIC_SHIFT");
        setValue("chromaticAberationRotation", "CHROMATIC_ROTATION");

        setValue("noise", "USE_NOISE");
        setValue("noiseScale", "NOISE_SCALE");
        setValue("noiseStrength", "NOISE_STRENGTH");
        setValue("noiseExponent", "NOISE_EXPONENT");

        setValue("detailBloom", "USE_DETAILBLOOM");
        setValue("detailBloomRadius", "DETAILBLOOM_RADIUS");
        setValue("detailBloomIntensity", "DETAILBLOOM_INTENSITY");
        setValue("detailBloomThreshold", "DETAILBLOOM_THRESHOLD");

        setValue("hdrBloom", "USE_HDRBLOOM");
        setValue("hdrBloomIterations", "HDRBLOOM_ITERATIONS");
        setValue("hdrBloomIntensity", "HDRBLOOM_INTENSITY");
        setValue("hdrBloomScatter", "HDRBLOOM_SCATTER");
        setValue("hdrBloomThreshold", "HDRBLOOM_THRESHOLD");
        setValue("hdrBloomSoftThreshold", "HDRBLOOM_SOFTTHRESHOLD");


        setValueCheck("background", "BACKGROUND_PATH", "backgroundChanged");
        setValueCheck("foreground", "FOREGROUND_PATH", "foregroundChanged");

        if (settings.glyphmapChanged)
            settings.recalcMaps = true;

        if (settings.bannerChanged)
            settings.recalcMaps = true;

        if (!defaultTexture) {
            initialize();
        }
    },
};

/***************************************************/
/*              Opengl helper functions            */
/***************************************************/

const blit = (() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    return (destination) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }
})();

function initFramebuffers() {
    settings.recalcFBOs = false;

    const texType = ext.halfFloatTexType;
    const rgba = ext.formatRGBA;
    const rg = ext.formatRG;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    var dim = settings.GLYPH_RENDER_DIMENSION
    valueMapWidth = Math.ceil(canvas.width / dim);
    valueMapHeight = Math.ceil(canvas.height / dim);

    uvMap = createFBO(canvas.width, canvas.height, rgba.internalFormat, rgba.format, texType, gl.NEAREST);
    valueMap = createDoubleFBO(valueMapWidth, valueMapHeight, rg.internalFormat, rg.format, texType, gl.NEAREST);
    generateMaps();

    bloomBuffer = createDoubleFBO(canvas.width, canvas.height, rgba.internalFormat, rgba.format, texType, filtering);
    glyphColorBuffer = createDoubleFBO(canvas.width, canvas.height, rgba.internalFormat, rgba.format, texType, filtering);
    glyphMaskBuffer = createDoubleFBO(canvas.width, canvas.height, rgba.internalFormat, rgba.format, texType, filtering);
    glyphBuffer = createFBO(canvas.width, canvas.height, rgba.internalFormat, rgba.format, texType, filtering);

    hdrBlurSamples = [];
    var width = canvas.width;
    var height = canvas.height;
    for (var i = 0; i < 8; i++) {
        if (width % 2 == 1)
            width++;
        width /= 2;

        if (height % 2 == 1)
            height++;
        height /= 2;

        if (width < 2 || height < 2)
            break;

        hdrBlurSamples.push(createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering));
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
}

function generateMaps()
{
    settings.recalcMaps = false;
    generateUvMap();
    generateValueMap();
}

function generateValueMap() {
    gl.viewport(0, 0, valueMapWidth, valueMapHeight);

    valueProgram.bind();

    if (!settings.USE_BANNER) {
        gl.uniform1i(valueProgram.uniforms.u_banner, defaultTexture.attach(0));
        blit(valueMap.write.fbo);
        valueMap.swap();
        gl.viewport(0, 0, canvas.width, canvas.height);
        return;
    }

    var adjustedWidth = banner.width * (canvas.height / banner.height);
    var widthFactor = canvas.width / adjustedWidth;
    var xOffset = ((canvas.width - adjustedWidth) / 2) / adjustedWidth;

    gl.uniform1i(valueProgram.uniforms.u_banner, banner.attach(0));
    gl.uniform1f(valueProgram.uniforms.u_widthFactor, widthFactor);
    gl.uniform1f(valueProgram.uniforms.u_xOffset, xOffset);
    gl.uniform2f(valueProgram.uniforms.u_valuemapTexel, 1.0 / valueMapWidth, 1.0 / valueMapHeight);

    blit(valueMap.write.fbo);
    valueMap.swap();

    var factor = settings.BANNER_FADE_DISTANCE / settings.GLYPH_RENDER_DIMENSION;
    var iterations = Math.ceil(factor);

    // generate the fade effect
    valueFadeEffectProgram.bind();
    gl.uniform2f(valueFadeEffectProgram.uniforms.u_texel,  1.0 / valueMapWidth, 1.0 / valueMapHeight);
    gl.uniform1f(valueFadeEffectProgram.uniforms.u_subtract, 1.0 / factor);
    gl.uniform1i(valueFadeEffectProgram.uniforms.u_rainDir, settings.RAIN_DIRMODE);
    gl.uniform1i(valueFadeEffectProgram.uniforms.u_UVMap, uvMap.attach(1));

    for (var i = 0; i < iterations; i++) {
        gl.uniform1i(valueProgram.uniforms.u_previous, valueMap.read.attach(0));
        blit(valueMap.write.fbo);
        valueMap.swap();
    }
}

function generateUvMap() {
    gl.viewport(0, 0, canvas.width, canvas.height);

    uvProgram.bind();
    gl.uniform2f(uvProgram.uniforms.u_outputDimension, canvas.width, canvas.height);
    gl.uniform2f(uvProgram.uniforms.u_valueMapTexel, 1.0 / valueMapWidth, 1.0 / valueMapHeight);
    gl.uniform1f(uvProgram.uniforms.u_glyphTexel, 1.0 / settings.realGlyphColRowCount);
    gl.uniform1f(uvProgram.uniforms.u_glyphRenderDimension, settings.GLYPH_RENDER_DIMENSION);

    blit(uvMap.fbo);
}


function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
        texture,
        fbo,
        width: w,
        height: h,
        attach(id) {
            gl.activeTexture(gl.TEXTURE0 + id);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return id;
        }
    };
}

function createDoubleFBO(w, h, internalFormat, format, type, param) {
    let fbo1 = createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = createFBO(w, h, internalFormat, format, type, param);

    return {
        get read() {
            return fbo1;
        },
        set read(value) {
            fbo1 = value;
        },
        get write() {
            return fbo2;
        },
        set write(value) {
            fbo2 = value;
        },
        swap() {
            let temp = fbo1;
            fbo1 = fbo2;
            fbo2 = temp;
        }
    }
}

function resizeFBO(target, w, h, internalFormat, format, type, param) {
    let newFBO = createFBO(w, h, internalFormat, format, type, param);
    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, target.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, 1);
    blit(newFBO.fbo);
    return newFBO;
}

function resizeDoubleFBO(target, w, h, internalFormat, format, type, param) {
    target.read = resizeFBO(target.read, w, h, internalFormat, format, type, param);
    target.write = createFBO(w, h, internalFormat, format, type, param);
    return target;
}

function createTexture(nearest, repeat) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);

    var interpolation = gl.LINEAR;
    if (nearest)
        interpolation = gl.NEAREST;

    var clamping = gl.CLAMP_TO_EDGE;
    if (repeat)
        clamping = gl.REPEAT;

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, interpolation);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, interpolation);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, clamping);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, clamping);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

    let obj = {
        texture,
        width: 1,
        height: 1,
        attach(id) {
            gl.activeTexture(gl.TEXTURE0 + id);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return id;
        },
        delete() {
            gl.deleteTexture(texture)
        }
    };

    return obj;
}

async function createTextureSync(url, nearest, repeat) {

    // only used for loading the starting images!
    let obj = createTexture(nearest, repeat);

    return new Promise((resolve, reject) => {
        let image = new Image();
        image.onload = () => {
            obj.width = image.width;
            obj.height = image.height;
            gl.bindTexture(gl.TEXTURE_2D, obj.texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            image.onload = null;
            resolve(obj)
        };

        image.onerror = () => {
            image.onerror = null;
            reject("Image not loaded");
        };
        image.src = url;
    });
}

/***************************************************/
/*           Shared properties and buffers         */
/***************************************************/

let uvMap;
let valueMap;
let valueMapWidth;
let valueMapHeight;
let hdrBlurSamples;

let glyphColorBuffer;
let glyphMaskBuffer;
let glyphBuffer;
let bloomBuffer;

let defaultTexture;
let glyphMap;
let colorGradient;
let noise;
let banner;
let background;
let foreground;

let defaultGlyphMap;
let defaultColorGradient;
let defaultBanner;

/***************************************************/
/*            Application specific Logic           */
/***************************************************/

const startTime = new Date();
let time = 0.0;

// Localize essa parte no final do script.js e adicione "./" antes dos nomes
async function initialize() {
    defaultTexture = createTexture();
    noise = await createTextureSync("./noise.png", false, true);
    defaultGlyphMap = await createTextureSync("./Glyphmap.png");
    defaultColorGradient = await createTextureSync("./ColorGradient.png");
    defaultBanner = await createTextureSync("./Banner.png");
    await reloadTextures();
    update();
}

let next = 0.5;
async function update() {
    time = (new Date() - startTime) / 1000.0;
    resizeCanvas();
    await reloadTextures();
    render();
    requestAnimationFrame(update);
}

function parseURL(url) {
    var uri = decodeURI(url);
    return uri.replace("%3A", ":");
}

async function reloadTextures() {

    if (settings.bannerChanged) {
        if (banner != null && banner != defaultBanner) {
            banner.delete();
        }

        if (settings.CUSTOM_BANNER_PATH != "") {
            try {
                banner = await createTextureSync(parseURL(settings.CUSTOM_BANNER_PATH), true, false);
            }
            catch
            {
                banner = defaultBanner
            }
        }
        else {
            banner = defaultBanner;
        }
        settings.bannerChanged = false;
    }

    if (settings.gradientChanged) {
        if (colorGradient != null && colorGradient != defaultColorGradient) {
            colorGradient.delete();
        }

        if (settings.CUSTOM_GRADIENT_PATH != "") {
            try {
                colorGradient = await createTextureSync(parseURL(settings.CUSTOM_GRADIENT_PATH), true, false);
            }
            catch
            {
                colorGradient = defaultColorGradient;
            }
        }
        else {
            colorGradient = defaultColorGradient;
        }

        settings.gradientChanged = false;
    }

    if (settings.glyphmapChanged) {
        if (glyphMap != null && glyphMap != defaultGlyphMap) {
            glyphMap.delete();
        }

        if (settings.CUSTOM_GLYPHMAP_PATH != "") {
            try {
                glyphMap = await createTextureSync(parseURL(settings.CUSTOM_GLYPHMAP_PATH), false, false);
            }
            catch
            {
                glyphMap = defaultGlyphMap;
            }
        }
        else {
            glyphMap = defaultGlyphMap;
        }

        settings.glyphmapChanged = false;
    }

    if (settings.backgroundChanged) {
        if (background != null && background != defaultTexture) {
            background.delete();
        }

        if (settings.BACKGROUND_PATH != "") {
            try {
                background = await createTextureSync(parseURL(settings.BACKGROUND_PATH), false, false);
            }
            catch
            {
                background = defaultTexture;
            }
        }
        else {
            background = defaultTexture;
        }

        settings.backgroundChanged = false
    }

    if (settings.foregroundChanged) {
        if (foreground != null && foreground != defaultTexture) {
            foreground.delete();
        }

        if (settings.FOREGROUND_PATH != "") {
            try {
                foreground = await createTextureSync(parseURL(settings.FOREGROUND_PATH), false, false);
            }
            catch
            {
                foreground = defaultTexture;
            }
        }
        else {
            foreground = defaultTexture;
        }

        settings.foregroundChanged = false
    }

    if (settings.recalcFBOs) {
        initFramebuffers();
        return;
    }

    if (settings.recalcMaps) {
        generateMaps();
    }
}

function resizeCanvas() {
    if (canvas.width != canvas.clientWidth || canvas.height != canvas.clientHeight) {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
        initFramebuffers();
    }
}

function renderMatrix() {
    glyphProgram.bind();
    gl.uniform1i(glyphProgram.uniforms.u_UVMap, uvMap.attach(0));
    gl.uniform1i(glyphProgram.uniforms.u_glyphMap, glyphMap.attach(1));
    gl.uniform1i(glyphProgram.uniforms.u_valueMap, valueMap.read.attach(2));
    gl.uniform1i(glyphProgram.uniforms.u_foreground, foreground.attach(3));

    gl.uniform1f(glyphProgram.uniforms.u_time, time + 100);

    gl.uniform1f(glyphProgram.uniforms.u_glyphCount, settings.realGlyphCount);
    gl.uniform1f(glyphProgram.uniforms.u_glyphRowColCount, settings.realGlyphColRowCount);

    gl.uniform1f(glyphProgram.uniforms.u_glyphChangeRate, settings.GLYPH_CHANGERATE);
    gl.uniform1f(glyphProgram.uniforms.u_glyphChangeRateRandom,
        Math.min(settings.GLYPH_CHANGERATE_RANDOM, 10.0 - settings.GLYPH_CHANGERATE));

    gl.uniform1f(glyphProgram.uniforms.u_rainLengthMin, settings.RAIN_LENGTH);
    gl.uniform1f(glyphProgram.uniforms.u_rainLengthRandom,
        Math.min(settings.RAIN_LENGTH_RANDOM, 3.0 - settings.RAIN_LENGTH));

    gl.uniform1f(glyphProgram.uniforms.u_rainSpacingMin, settings.RAIN_SPACING);
    gl.uniform1f(glyphProgram.uniforms.u_rainSpacingRandom,
        Math.min(settings.RAIN_SPACING_RANDOM, 1.0 - settings.RAIN_SPACING));

    gl.uniform1f(glyphProgram.uniforms.u_rainSpeedMin, settings.RAIN_SPEED);

    gl.uniform1f(glyphProgram.uniforms.u_rainSpeedRandom,
        Math.min(settings.RAIN_SPEED_RANDOM, 10.0 - settings.RAIN_SPEED));

    gl.uniform1i(glyphProgram.uniforms.u_rainDir, settings.RAIN_DIRMODE);

    gl.uniform1f(glyphProgram.uniforms.u_valueMin, settings.COLOR_VALUE);
    gl.uniform1f(glyphProgram.uniforms.u_valueAdd,
        Math.max(settings.COLOR_VALUE_FADE - settings.COLOR_VALUE, 0));
    gl.uniform1f(glyphProgram.uniforms.u_bannerValue, settings.COLOR_VALUE_BANNER);

    blit(glyphColorBuffer.write.fbo);
    glyphColorBuffer.swap();
}

function renderMatrixColorMask() {
    // rendering out the mask
    glyphMaskProgram.bind();
    gl.uniform1i(glyphMaskProgram.uniforms.u_texture, glyphColorBuffer.read.attach(0));

    blit(glyphMaskBuffer.write.fbo);
    glyphMaskBuffer.swap();

    // rendering out the color
    glyphColorProgram.bind();
    gl.uniform1i(glyphColorProgram.uniforms.u_texture, glyphColorBuffer.read.attach(0));
    gl.uniform1i(glyphColorProgram.uniforms.u_colorGradient, colorGradient.attach(1));

    blit(glyphColorBuffer.write.fbo);
    glyphColorBuffer.swap();
}

function renderMatrixColorMaskCA() {
    // with chromatic aberation
    var radians = settings.CHROMATIC_ROTATION * (Math.PI / 180.0);
    var offset_x = Math.cos(radians) * settings.CHROMATIC_SHIFT / canvas.width;
    var offset_y = Math.sin(radians) * settings.CHROMATIC_SHIFT / canvas.height;

    // rendering out the mask
    glyphMaskCAProgram.bind();
    gl.uniform1i(glyphMaskCAProgram.uniforms.u_texture, glyphColorBuffer.read.attach(0));
    gl.uniform2f(glyphMaskCAProgram.uniforms.u_offset, offset_x, offset_y);

    blit(glyphMaskBuffer.write.fbo);
    glyphMaskBuffer.swap();

    // rendering out the color
    glyphColorCAProgram.bind();
    gl.uniform1i(glyphColorCAProgram.uniforms.u_texture, glyphColorBuffer.read.attach(0));
    gl.uniform1i(glyphColorCAProgram.uniforms.u_colorGradient, colorGradient.attach(1));
    gl.uniform2f(glyphColorCAProgram.uniforms.u_offset, offset_x, offset_y);

    blit(glyphColorBuffer.write.fbo);
    glyphColorBuffer.swap();
}

function renderCompileGlyph(addBuffer) {
    compileGlyphProgram.bind();

    gl.uniform1i(compileGlyphProgram.uniforms.u_glyphColor, glyphColorBuffer.read.attach(0));
    gl.uniform1i(compileGlyphProgram.uniforms.u_glyphMask, glyphMaskBuffer.read.attach(1));
    gl.uniform1i(compileGlyphProgram.uniforms.u_add, addBuffer.attach(2));

    blit(glyphBuffer.fbo);
}

function renderGaussianBlur(doubleBuffer) {
    gaussianBlurProgram.bind();
    gl.uniform2f(gaussianBlurProgram.uniforms.u_texel, 1.0 / canvas.width, 1.0 / canvas.height);

    gl.uniform2f(gaussianBlurProgram.uniforms.u_direction, 0, settings.BLUR_RADIUS);
    gl.uniform1i(gaussianBlurProgram.uniforms.u_texture, doubleBuffer.read.attach(0));
    blit(doubleBuffer.write.fbo);
    doubleBuffer.swap();

    gl.uniform2f(gaussianBlurProgram.uniforms.u_direction, settings.BLUR_RADIUS, 0);
    gl.uniform1i(gaussianBlurProgram.uniforms.u_texture, doubleBuffer.read.attach(0));

    blit(doubleBuffer.write.fbo);
    doubleBuffer.swap();
}

function renderNoise(doubleBuffer) {
    noiseProgram.bind();
    gl.uniform1i(noiseProgram.uniforms.u_texture, doubleBuffer.read.attach(0));
    gl.uniform1i(noiseProgram.uniforms.u_noise, noise.attach(1));
    gl.uniform1f(noiseProgram.uniforms.u_aspect, canvas.width / canvas.height);
    gl.uniform1f(noiseProgram.uniforms.u_time, time);
    gl.uniform1f(noiseProgram.uniforms.u_noiseScale, settings.NOISE_SCALE);
    gl.uniform1f(noiseProgram.uniforms.u_noiseStrength, settings.NOISE_STRENGTH);
    gl.uniform1f(noiseProgram.uniforms.u_noiseExponent, settings.NOISE_EXPONENT);

    blit(doubleBuffer.write.fbo);
    doubleBuffer.swap();
}

function renderDetailBloom() {
    detailBloomProgram.bind();
    gl.uniform2f(detailBloomProgram.uniforms.u_texel, 1.0 / canvas.width, 1.0 / canvas.height);
    gl.uniform1f(detailBloomProgram.uniforms.u_bloomIntensity, settings.DETAILBLOOM_INTENSITY);
    gl.uniform1f(detailBloomProgram.uniforms.u_bloomThreshold, settings.DETAILBLOOM_THRESHOLD);
    gl.uniform1f(detailBloomProgram.uniforms.u_bloomThresholdFactor, 1.0 / (1 - settings.DETAILBLOOM_THRESHOLD));
    gl.uniform1i(detailBloomProgram.uniforms.u_glyph, glyphBuffer.attach(1));

    gl.uniform2f(detailBloomProgram.uniforms.u_direction, 0, settings.DETAILBLOOM_RADIUS);
    gl.uniform1i(detailBloomProgram.uniforms.u_texture, defaultTexture.attach(0));

    blit(bloomBuffer.write.fbo);
    bloomBuffer.swap();

    gl.uniform2f(detailBloomProgram.uniforms.u_direction, settings.DETAILBLOOM_RADIUS, 0);
    gl.uniform1i(detailBloomProgram.uniforms.u_texture, bloomBuffer.read.attach(0));

    blit(bloomBuffer.write.fbo);
    bloomBuffer.swap();
}

function renderHDRBloom(base) {
    var samples = [
        glyphBuffer,
        ...hdrBlurSamples
    ];
    var sampleCount = Math.min(settings.HDRBLOOM_ITERATIONS, hdrBlurSamples.length);

    var th = settings.HDRBLOOM_THRESHOLD;
    var sth = settings.HDRBLOOM_SOFTTHRESHOLD;
    var knee = th * sth;

    // downsampling
    hdrBloomDownSampleProgram.bind();

    gl.uniform4f(hdrBloomDownSampleProgram.uniforms.u_thresholdParams,
        th, th - knee, 2 * knee, 0.25 / (knee + 0.00001));
    gl.uniform1f(hdrBloomDownSampleProgram.uniforms.u_intensity, settings.HDRBLOOM_INTENSITY)

    for (var i = 0; i < sampleCount; i++) {
        var texelX = 1.0 / samples[i].width;
        var texelY = 1.0 / samples[i].height;
        gl.uniform4f(hdrBloomDownSampleProgram.uniforms.u_offsets, -texelX, -texelY, texelX, texelY);
        gl.uniform1i(hdrBloomDownSampleProgram.uniforms.u_texture, samples[i].attach(0));

        var outSample = samples[i + 1];
        gl.viewport(0, 0, outSample.width, outSample.height);
        blit(outSample.fbo);
    }

    // upsampling
    hdrBloomUpSampleProgram.bind();
    gl.uniform1f(hdrBloomUpSampleProgram.uniforms.u_scatter, settings.HDRBLOOM_SCATTER * 0.25)
    for (var i = sampleCount; i > 1; i--) {
        var texelX = 0.5 / samples[i].width;
        var texelY = 0.5 / samples[i].height;
        gl.uniform4f(hdrBloomUpSampleProgram.uniforms.u_offsets, -texelX, -texelY, texelX, texelY);
        gl.uniform1i(hdrBloomUpSampleProgram.uniforms.u_texture, samples[i].attach(0));

        var outSample = samples[i - 1];
        gl.viewport(0, 0, outSample.width, outSample.height);
        blit(outSample.fbo);
    }

    // last upsample into the target
    hdrBloomCombineProgram.bind();
    var texelX = 0.5 / samples[1].width;
    var texelY = 0.5 / samples[1].height;
    gl.uniform4f(hdrBloomCombineProgram.uniforms.u_offsets, -texelX, -texelY, texelX, texelY);
    gl.uniform1i(hdrBloomCombineProgram.uniforms.u_bloom, samples[1].attach(0));
    gl.uniform1i(hdrBloomCombineProgram.uniforms.u_texture, base.attach(1));
    gl.viewport(0, 0, canvas.width, canvas.height);
    blit(bloomBuffer.write.fbo);
    bloomBuffer.swap();
}

function combineBG(bloom) {

    combineBGProgram.bind();

    gl.uniform1i(combineBGProgram.uniforms.u_glyphColor, glyphColorBuffer.read.attach(0));
    gl.uniform1i(combineBGProgram.uniforms.u_glyphMask, glyphMaskBuffer.read.attach(1));
    gl.uniform1i(combineBGProgram.uniforms.u_background, background.attach(2));
    gl.uniform1i(combineBGProgram.uniforms.u_foreground, foreground.attach(3));
    gl.uniform1i(combineBGProgram.uniforms.u_bloom, bloom.attach(4));

    blit(null);
}

function render() {

    renderMatrix()

    if (settings.CHROMATIC_SHIFT > 0) {
        renderMatrixColorMaskCA();
    }
    else {
        renderMatrixColorMask();
    }

    if (settings.BLUR_RADIUS > 0) {
        renderGaussianBlur(glyphColorBuffer);
        renderGaussianBlur(glyphMaskBuffer);
    }

    if (settings.USE_NOISE) {
        renderNoise(glyphColorBuffer);
        renderNoise(glyphMaskBuffer);
    }

    let bloom = defaultTexture;
    if (settings.USE_DETAILBLOOM || settings.USE_HDRBLOOM) {

        let base = defaultTexture;

        if (settings.USE_DETAILBLOOM) {
            renderCompileGlyph(base);
            renderDetailBloom();
            base = bloomBuffer.read;
        }

        if (settings.USE_HDRBLOOM) {
            renderCompileGlyph(base);
            renderHDRBloom(base);
        }

        bloom = bloomBuffer.read;
    }

    combineBG(bloom);

    /*debugProgram.bind();
    gl.uniform1i(debugProgram.uniforms.u_debug, valueMap.read.attach(0));
    gl.uniform1i(debugProgram.uniforms.u_debug, uvMap.attach(0));
    blit(null);*/
}

