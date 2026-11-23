"""Exercise the candidate's copied app/src and shared source in an isolated clean Vite preview.

Run with Homebrew Python 3.13, which has Playwright. The preview URL is a local, owned server.
No wallet or public-network action occurs.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


url = sys.argv[1]
out = Path(sys.argv[2])
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.on("pageerror", lambda error: errors.append(str(error)))
    response = page.goto(url, wait_until="networkidle")
    assert response and response.status == 200
    assert page.get_by_text("Design your pool").is_visible()

    page.get_by_role("button", name="Adjust prizes by hand ▾").click()

    def count(label):
        return int(page.get_by_role("button", name=f"One more {label}").evaluate(
            '(e) => e.parentElement.querySelector("output").textContent'
        ))

    start = {"small": count("0.01 ETH Shape"), "pack": count("0.02 ETH Pack"),
             "medium": count("0.05 ETH Shape"), "large": count("0.1 ETH Shape")}
    assert start == {"small": 10, "pack": 3, "medium": 5, "large": 1}

    for _ in range(start["small"]):
        page.get_by_role("button", name="One fewer 0.01 ETH Shape").click()
    zero = {"small": count("0.01 ETH Shape"), "pack": count("0.02 ETH Pack"),
            "medium": count("0.05 ETH Shape"), "large": count("0.1 ETH Shape")}
    assert zero == {"small": 0, "pack": 3, "medium": 5, "large": 1}
    slider = page.locator("#small")
    assert slider.get_attribute("min") == "0"
    assert slider.input_value() == "0"
    assert "Custom:" in page.locator("body").inner_text()
    page.screenshot(path=str(out.with_suffix(".png")), full_page=True)

    slider.focus()
    for _ in range(7):
        slider.press("ArrowRight")
    after_slider = {"small": count("0.01 ETH Shape"), "pack": count("0.02 ETH Pack"),
                    "medium": count("0.05 ETH Shape"), "large": count("0.1 ETH Shape")}
    assert after_slider == {"small": 7, "pack": 3, "medium": 5, "large": 1}

    page.get_by_role("button", name="How it works").click()
    assert page.get_by_text("One inventory, two kinds of prizes").is_visible()
    assert not errors, errors
    browser.close()

result = {"http": 200, "initial": start, "hand_edited": zero, "after_size_control": after_slider,
          "faq_opened": True, "page_errors": errors, "wallet_connected": False}
out.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
