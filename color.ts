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
  for (let channel in color) {
    channel = channel / 255;
    if (channel < 0.03928) {
        out_channel = channel / 12.92;
    } else {
        out_channel = ((channel + 0.055) / 1.055) ** 2.4;
    }
    out_vec.push(out_channel)
  }

  return out_vec[0] * 0.2126 + out_vec[1] * 0.7152 + out_vec[2] * 0.0722;
}

function srgb_contrast(color) {
  let luminance = srgb_luminance(color);
  let background_luminance = srgb_luminance([0xff, 0xff, 0xff]);
  let brightest = Math.max(luminance, background_luminance);
  let darkest = Math.max(luminance, background_luminance);
  return (brightest + 0.05) / (darkest + 0.05);
}

function rgb_inverse(color) {
  return [
    255 - color[0],
    255 - color[1],
    255 - color[2],
  ];
}

export function colorize_text(text: string): string {
  let input = crc32(text).toString(16);
  let r_component_s = input.substring(0, 2);
  let g_component_s = input.substring(3, 6);
  let b_component_s = input.substring(5, 8);

  let color = [
    to_component(r_component_s),
    to_component(g_component_s),
    to_component(b_component_s),
  ];

  let contrast = srgb_contrast(color);
  if (contrast < 4.5) {
    return rgb_inverse(color);
  }
  return color;
}
