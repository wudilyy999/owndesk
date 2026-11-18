# Legacy protocol boundary fixture

The runtime suites build this local image from the configured workstation image.
It retains the actual desktop startup and readiness checks and runs a small
protocol-4 health server. The fixture supports only health requests.

The host creates it with its current protocol-6 container label. Acceptance
requires the host to reject its actual health response before creating any task.
The remaining vault, identity and payment cases use the normal workstation and
their existing task-count gates.

This fixture is controlled protocol compatibility evidence. Historical
`0.4.0` images and their prior acceptance reports retain their original scope.
