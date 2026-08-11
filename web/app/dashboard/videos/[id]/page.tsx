import VideoDetailClient from "./video-detail-client";

export function generateStaticParams() {
  return [{ id: "placeholder" }];
}

export default function VideoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <VideoDetailClient params={params} />;
}
