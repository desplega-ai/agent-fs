// Check if MinIO is available at localhost:9000
export async function isMinioAvailable(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:9000/minio/health/live");
    return res.ok;
  } catch {
    return false;
  }
}
