import { Navigate, useParams } from "react-router"

/**
 * Old links to /videos/<id> open the video's details window on the Videos
 * page instead.
 */
export function VideoPage() {
  const { id = "" } = useParams()
  return <Navigate to={`/videos?video=${encodeURIComponent(id)}`} replace />
}
