function clampDimension(value) {
  return Math.max(1, Math.round(Number(value) || 1));
}

function createJimpSharpCompat(Jimp, version = "") {
  const decodeCache = new WeakMap();

  async function decode(sourceBuffer) {
    let decoded = decodeCache.get(sourceBuffer);
    if (!decoded) {
      decoded = Jimp.read(sourceBuffer).then((image) => {
        if (image && typeof image.exifRotate === "function") {
          image.exifRotate();
        }
        return image;
      });
      decodeCache.set(sourceBuffer, decoded);
    }
    return decoded;
  }

  function resizeInside(image, options = {}) {
    const maxWidth = Number(options.width) || image.bitmap.width;
    const maxHeight = Number(options.height) || image.bitmap.height;
    const scale = Math.min(
      1,
      maxWidth / image.bitmap.width,
      maxHeight / image.bitmap.height
    );
    if (scale < 1) {
      image.resize(
        clampDimension(image.bitmap.width * scale),
        clampDimension(image.bitmap.height * scale),
        Jimp.RESIZE_BILINEAR
      );
    }
  }

  function resizeCover(image, width, height, options = {}) {
    const requestedWidth = clampDimension(width);
    const requestedHeight = clampDimension(height);
    const targetWidth = options.withoutEnlargement
      ? Math.min(requestedWidth, image.bitmap.width)
      : requestedWidth;
    const targetHeight = options.withoutEnlargement
      ? Math.min(requestedHeight, image.bitmap.height)
      : requestedHeight;
    const squareSize = Math.min(targetWidth, targetHeight);
    image.cover(
      squareSize,
      squareSize,
      Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE
    );
  }

  function factory(sourceBuffer) {
    let resizeArgs = null;
    let jpegOptions = {};

    const pipeline = {
      rotate() {
        return pipeline;
      },
      toColorspace() {
        return pipeline;
      },
      resize(widthOrOptions, height, options) {
        resizeArgs =
          typeof widthOrOptions === "object"
            ? { mode: "inside", options: widthOrOptions || {} }
            : {
              mode: "cover",
              width: widthOrOptions,
              height,
              options: options || {},
            };
        return pipeline;
      },
      jpeg(options = {}) {
        jpegOptions = options;
        return pipeline;
      },
      async metadata() {
        const image = await decode(sourceBuffer);
        return {
          width: image.bitmap.width,
          height: image.bitmap.height,
        };
      },
      async toBuffer() {
        const source = await decode(sourceBuffer);
        const image = source.clone();
        if (resizeArgs && resizeArgs.mode === "inside") {
          resizeInside(image, resizeArgs.options);
        } else if (resizeArgs) {
          resizeCover(
            image,
            resizeArgs.width,
            resizeArgs.height,
            resizeArgs.options
          );
        }
        image.quality(Number(jpegOptions.quality) || 80);
        return image.getBufferAsync(Jimp.MIME_JPEG);
      },
    };

    return pipeline;
  }

  factory.versions = {
    jimp: version,
  };
  return factory;
}

module.exports = {
  createJimpSharpCompat,
};
