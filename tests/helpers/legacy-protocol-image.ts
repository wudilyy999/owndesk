import { docker } from "@/lib/docker"

export async function legacyProtocolImage(workstationImage: string) {
  const image = "owndesk-workstation:test-protocol4"
  await docker(
    [
      "build",
      "--network",
      "none",
      "--build-arg",
      `WORKSTATION_IMAGE=${workstationImage}`,
      "--tag",
      image,
      "tests/fixtures/legacy-workstation",
    ],
    { timeoutMs: 120000 }
  )
  return image
}
