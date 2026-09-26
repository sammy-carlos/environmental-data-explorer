// The Kipu360 logo for the images and documents the explorer downloads.
let logo = null;

// An SVG with only a viewBox has no size of its own, and some browsers will not draw it on
// a canvas; the logo is given one before it is loaded.
export function loadLogo() {
  logo ??= (async () => {
    const text = await (await fetch("./assets/kipu360.svg")).text();
    const [, , , width, height] = text.match(/viewBox="([\d.-]+) ([\d.-]+) ([\d.]+) ([\d.]+)"/) || [];
    const sized = width ? text.replace("<svg ", `<svg width="${width}" height="${height}" `) : text;
    const url = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml" }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  // A failed load is not kept, so the next download tries again.
  logo.catch(() => { logo = null; });
  return logo;
}
