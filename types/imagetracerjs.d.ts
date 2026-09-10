declare module 'imagetracerjs' {
  type ImageTracerColor = {
    r: number;
    g: number;
    b: number;
    a: number;
  };

  type ImageTracerOptions = {
    ltres?: number;
    qtres?: number;
    pathomit?: number;
    rightangleenhance?: boolean;
    colorsampling?: number;
    numberofcolors?: number;
    mincolorratio?: number;
    colorquantcycles?: number;
    layering?: number;
    strokewidth?: number;
    linefilter?: boolean;
    scale?: number;
    roundcoords?: number;
    viewbox?: boolean;
    desc?: boolean;
    blurradius?: number;
    blurdelta?: number;
    pal?: ImageTracerColor[];
  };

  type ImageDataLike = {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  };

  const ImageTracer: {
    imagedataToSVG(
      imageData: ImageDataLike,
      options?: ImageTracerOptions | string,
    ): string;
  };

  export default ImageTracer;
}
