import { BatchWorkspace } from "@/components/batch-workspace";

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BatchWorkspace batchId={id} />;
}
