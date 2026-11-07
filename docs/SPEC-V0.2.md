# Even G2 Personal Assistant: Technical Specification V0.2

The owner's original spec, kept as the baseline. [SPEC-V0.3.md](SPEC-V0.3.md) replaces it.

## 1. Project Objective

Build a private, hands-free personal assistant for the Even Realities G2 A smart glasses.

The system must support head-gesture navigation, instant content hiding and restoring, automatic privacy protection when the glasses are removed, and AI-powered visual assistance using an external camera.

The user should not need to touch their smartphone during normal operation. A paired smartphone may operate as a communication bridge while remaining locked in the user's pocket.

Use the official Even Hub SDK where possible. Do not assume unsupported system-level capabilities.

## 2. Approved Head Gestures

### Gesture A: Scroll Up

**Trigger:** Deliberately tilt the head upward.

- Scroll the current content upward.
- Use calibrated tilt thresholds relative to the user's neutral head position.
- Support controlled scrolling while the head remains tilted.
- Stop scrolling when the head returns to neutral.
- Prevent accidental scrolling during normal conversation or walking.

### Gesture B: Scroll Down

**Trigger:** Deliberately tilt the head downward.

- Scroll content downward.
- Use the same calibration and smoothing system as Scroll Up.
- Stop at content boundaries.
- Avoid repeated unintended scrolling.

### Gesture C: Toggle Content Visibility

**Trigger:** A deliberate left-right head shake.

- If content is visible, immediately hide all application content.
- If content is hidden, restore it.
- Restore the exact previous screen, response, and scroll position.
- Do not show any application text, loading indicator, or other readable information in Hidden Mode.
- Keep the application operational while its content is hidden, wherever the SDK permits.
- Prevent normal head turns from triggering this command.

**Gesture recognition:**

- Detect a defined alternating yaw movement.
- Use configurable amplitude and timing thresholds.
- Require a recognizable left-right pattern rather than a simple head turn.
- Include cooldown, hysteresis, and accidental-trigger protection.
- Give this gesture priority over scrolling gestures.

**Critical technical validation:** Determine whether Even G2 IMU events remain available when the application's visual content is blank. If the official SDK cannot receive gesture events in this state, document the limitation and implement the closest supported fallback. Do not claim the same gesture can wake a system-disabled display without proof.

### Gesture D: Automatic Hide on Removal

**Trigger:** The glasses are removed from the user's face.

- Hide the application's content automatically using available wear-detection events.
- Maintain the hidden state when the glasses are worn again.
- Do not restore content automatically on re-wear.
- Only the approved left-right head shake should restore visibility during normal operation.
- Ignore gestures detected while the glasses are not being worn.

If wear detection is unreliable or unavailable, provide a documented fallback.

## 3. Application State Machine

- **VISIBLE:** Content is displayed; scrolling is enabled.
- **HIDDEN:** Application content is blank; restore gesture remains available if supported.
- **REMOVED:** Glasses are not being worn; content must remain hidden.
- **PROCESSING:** An AI request is running; show status only if visibility is enabled.
- **RESULT_READY:** The latest AI response is available.
- **ERROR:** A recoverable failure occurred, with no private content exposed.

Required transitions:

- VISIBLE + left-right shake → HIDDEN.
- HIDDEN + left-right shake + glasses worn → VISIBLE.
- VISIBLE or HIDDEN + glasses removed → REMOVED.
- REMOVED + glasses worn again → HIDDEN.
- HIDDEN + AI result received → Store result without revealing content.
- HIDDEN + upward/downward tilt → Ignore scrolling.
- VISIBLE + deliberate upward/downward tilt → Scroll.

Preserve current application context across hide/show operations. Do not expose hidden content automatically after reconnection or application restart.

## 4. External Camera Integration

Use a compact external camera with a physical capture button. Candidate hardware: ESP32-S3 camera module or another suitable low-power camera.

1. User presses the physical capture button.
2. Camera captures a still image.
3. Image is transferred securely via Wi-Fi or another verified connection.
4. Image reaches the AI backend automatically.
5. Backend processes the image.
6. A concise response is delivered to the G2 application.
7. User navigates the response using the approved head gestures.

No smartphone interaction should be required once the system is initialized. Evaluate Bluetooth, Wi-Fi hotspot, and dedicated companion-app architectures. Use an intentional capture action and appropriate capture indication. Protect images and obtain consent where required.

## 5. AI Assistant

- Technical questions and document analysis.
- Printed and handwritten text.
- Diagrams and visual explanations.
- Short answers followed by optional detailed explanations.
- English as the initial response language.
- Error handling and uncertainty reporting.
- Secure and minimal image retention.

The initial result should be readable on the glasses without excessive scrolling.

## 6. Head Gesture Calibration

Calibrate neutral head position, upward tilt threshold, downward tilt threshold, left-right shake sensitivity, motion smoothing, gesture cooldown intervals, scroll speed, and minimum gesture duration.

Initial thresholds are experimental values, not fixed hardware facts. Users must be able to adjust sensitivity without changing source code.

## 7. User Experience Rules

- No touchpad interaction required for normal navigation if gesture testing succeeds.
- No unexpected application content when the glasses are removed.
- No automatic reveal when the glasses are worn again.
- No visual clutter.
- Preserve the last AI answer.
- Queue new AI responses while content is hidden.
- Recover automatically from temporary connectivity failures.
- Keep a supported manual recovery method for SDK or gesture failures.

## 8. Architecture Investigation

Propose the simplest reliable architecture involving Even G2 hardware, an Even Hub SDK application, a paired Android or iOS phone, the external camera and capture button, a secure AI backend, and real-time response delivery.

Verify whether a separate native mobile companion is required. Investigate background execution when the smartphone is locked and the application is inactive. Do not claim that the glasses can connect directly to the external camera unless verified.

## 9. Acceptance Tests

1. **Upward Scrolling:** with multi-page content, tilting up scrolls up; neutral stops it.
2. **Downward Scrolling:** tilting down scrolls down; neutral stops it.
3. **Hide Gesture:** a deliberate shake makes all app content disappear promptly, without navigating away.
4. **Show Gesture:** repeating the shake returns the original content and scroll position.
5. **Accidental Activation:** walking, talking, looking sideways, and ordinary movement must not repeatedly trigger hide/show or scrolling.
6. **Removal Protection:** removing the glasses with sensitive content displayed hides it.
7. **Re-wear Protection:** content stays hidden after re-wear until the deliberate shake.
8. **Camera-to-AI Workflow:** the button press leads to capture, secure upload, AI processing, and automatic delivery without touching the phone.
9. **Hidden AI Result:** a capture while hidden is processed and stored without revealing it.
10. **Connectivity Recovery:** interrupting network or Bluetooth recovers safely without revealing hidden content.
11. **Competing Gestures:** up/down movement during a shake still gives the toggle priority, with no accidental scrolling.
12. **Locked Smartphone:** the whole capture-to-answer workflow runs with the phone locked in a pocket.

## 10. Development Deliverables

1. Inspect the current official Even Hub SDK and hardware documentation.
2. Create a feature-by-feature feasibility matrix: Supported, Experimental, or Unsupported.
3. Identify exact SDK methods and restrictions.
4. Design the gesture recognition state machine.
5. Build a simulator prototype with synthetic motion data.
6. Implement automated unit and integration tests.
7. Define experiments requiring physical G2 hardware.
8. Propose the final external camera communication design.
9. Recommend the minimum necessary additional hardware.
10. Prepare a phased implementation plan.

## 11. Implementation Principles

Prioritize stability, privacy, low latency, and minimal interaction. Avoid unsupported firmware modifications. Do not invent APIs or assume unrestricted hardware access. Use actual hardware tests to validate head tracking, wear detection, and hidden-mode restoration.

The final experience should feel like a discreet, responsive personal interface operated primarily through deliberate head gestures and a single external camera button.
