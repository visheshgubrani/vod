/**
 * The two code samples on the page. Both are shown in the same panel, so they
 * carry the same shape: the file they live in, the surface they run on, and the
 * snippet itself.
 *
 * The upload excerpt is the usage documented by the working Next.js
 * integration in `examples/nextjs-integration`, which is compiled on every
 * commit: `ClipMuxUploader` is constructed with an upload token, `startUpload`
 * returns a session, and `run()` resolves to the uploaded file id. Nothing here
 * is invented.
 */
export type CodeSurface = "Browser" | "Shell";

export type CodeExample = {
  file: string;
  surface: CodeSurface;
  code: string;
};

export const uploadExample: CodeExample = {
  file: "app/upload-form.tsx",
  surface: "Browser",
  code: `import { ClipMuxUploader } from "@clipmux/uploader";

// The upload token comes from your backend route.
const uploader = new ClipMuxUploader({ baseUrl, uploadToken });

const session = uploader.startUpload(file, {
  title: file.name,
  playbackPolicy: "signed",
  onProgress: ({ percentage }) => setProgress(percentage),
});

const result = await session.run();
// result.fileId — poll GET /v1/video/:id, or wait for video.ready`,
};

/**
 * The bootstrap commands. The clone URL comes from the site configuration
 * rather than a second hard-coded copy of the repository address, and the
 * snippet has no shell prompts: it is exactly what you paste into a terminal.
 */
export function bootstrapExample(githubUrl: string): CodeExample {
  return {
    file: "scripts/bootstrap.sh",
    surface: "Shell",
    code: `git clone ${githubUrl}.git
cd vod
./scripts/bootstrap.sh`,
  };
}
