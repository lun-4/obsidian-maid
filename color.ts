import { default as funny } from "pcg-random";

// crc32 impl from https://stackoverflow.com/a/18639999
function makeCRCTable() {
  var c;
  var crcTable = [];
  for(var n =0; n < 256; n++){
      c = n;
      for(var k =0; k < 8; k++){
          c = ((c&1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
      }
      crcTable[n] = c;
  }
  return crcTable;
}

function crc32(str: string): number {
  var crcTable = window.crcTable || (window.crcTable = makeCRCTable());
  var crc = 0 ^ (-1);

  for (var i = 0; i < str.length; i++ ) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ str.charCodeAt(i)) & 0xFF];
  }

  return (crc ^ (-1)) >>> 0;
};

function to_component(component_hex: string) {
  let component_num = parseInt(component_hex, 16);
  return Math.max(0xaa, 0xaa + (component_num * 3)) & 0xff;
  
}

// magic from
// https://stackoverflow.com/questions/9733288/how-to-programmatically-calculate-the-contrast-ratio-between-two-colors

function srgb_luminance(color) {
  let out_vec = [];
  for (let channel of color) {
    channel = channel / 255;
    let out_channel = undefined;
    if (channel < 0.03928) {
        out_channel = channel / 12.92;
    } else {
        out_channel = Math.pow(((channel + 0.055) / 1.055), 2.4);
    }
    out_vec.push(out_channel);
  }

  return (out_vec[0] * 0.2126) + (out_vec[1] * 0.7152) + (out_vec[2] * 0.0722);
}

function raw_contrast(luminance, other_luminance) {
  let brightest = Math.max(luminance, other_luminance);
  let darkest = Math.min(luminance, other_luminance);
  return (brightest + 0.05) / (darkest + 0.05);
}

function srgb_contrast(color) {
  let luminance = srgb_luminance(color);
  let foreground_luminance = srgb_luminance([0xda, 0xda, 0xda]);
  let background_luminance = srgb_luminance([0x1e, 0x1e, 0x1e]);

  let contrast = raw_contrast(luminance, foreground_luminance);
  let background_contrast = raw_contrast(luminance, background_luminance)

  return (contrast * 0.8) + (background_contrast * 0.2)
}

function rgb_inverse(color) {
  return [
    255 - color[0],
    255 - color[1],
    255 - color[2],
  ];
}


function best_contrast(contrasts) {
  let max_contrast = 0;
  let max_contrast_index = 0;
  for (const idx in contrasts) {
    const element = contrasts[idx];
    if (element > max_contrast) {
      max_contrast = element;
      max_contrast_index = idx;
    }
  }
  return [max_contrast, max_contrast_index];
}

function random_component(random) {
  const component_num = random.integer(0xff);
  return Math.max(0x55, 0x55 + (component_num * 2)) & 0xff;
}

export function colorize_text(text: string): string {
  let input = crc32(text);
  let random = new funny();
  random.setSeed(input);

  let possible_colors = [];
  let contrasts = [];
  for (const idx of [0,1,2,3,4]) {
    let color = [
      random_component(random),
      random_component(random),
      random_component(random),
    ];
    possible_colors.push(color);
    contrasts.push(srgb_contrast(color));
  }

  let [max_contrast, max_contrast_index] = best_contrast(contrasts);

  if (max_contrast < 4.5) {
    // invert everything
    let inverted_colors = possible_colors.map(x => rgb_inverse(x));
    let inverted_contrasts = inverted_colors.map(x => srgb_contrast(x));
    let [iv_max_contrast, iv_max_contrast_index] = best_contrast(contrasts);
    if (iv_max_contrast < max_contrast) {
      return possible_colors[max_contrast_index];
    } else {
      return inverted_colors[iv_max_contrast_index];
    }
  } else {
    return possible_colors[max_contrast_index];
  }
}
