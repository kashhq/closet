/**
 * Stands in for public/js/photo-input.js in the actions browser spec: a
 * choice of files "prepares" to a file, an empty choice to nothing, as the
 * real preparePhoto does, without a canvas.
 */
export const preparePhoto = (input: HTMLInputElement): Promise<File | null> =>
  Promise.resolve(input.files?.[0] ?? null);
