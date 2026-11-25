"""Opens the dashboard in headless Chrome, logs in, visits every page, does real actions, screenshots."""
import sys
from playwright.sync_api import sync_playwright

B = "http://127.0.0.1:9800"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/kr"
errors = []

with sync_playwright() as p:
    br = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg = br.new_page(viewport={"width": 1440, "height": 960}, color_scheme="dark")
    # the reported case: system in dark mode, KeyRouter set to light
    pg.add_init_script("try { if (!localStorage.getItem('kr_theme')) localStorage.setItem('kr_theme', 'light'); } catch (e) {}")
    pg.on("console", lambda m: errors.append("console " + m.type + ": " + m.text) if m.type in ("error", "warning") else None)
    pg.on("response", lambda r: errors.append("HTTP " + str(r.status) + " " + r.request.method + " " + r.url) if r.status >= 400 else None)
    pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))

    # login fails closed, then works
    pg.goto(B + "/")
    pg.fill("input[name=k]", "wrong-key")
    pg.click("button[type=submit]")
    pg.wait_for_selector(".err")
    assert "invalid admin key" in pg.inner_text(".login")
    errors[:] = [e for e in errors if "401" not in e]
    pg.fill("input[name=k]", "admin-secret-123")
    pg.click("button[type=submit]")
    pg.wait_for_selector("text=Tokens per day")
    kpis = pg.inner_text(".g4")
    assert "Tokens today" in kpis and "Free models ready" in kpis, kpis
    # daily free capacity cards
    capt = pg.inner_text(".capcard >> nth=0") + pg.inner_text(".capcard >> nth=1")
    assert "Free requests today" in capt and "Free tokens today" in capt and "requests left" in capt and "tokens left" in capt and " used" in capt, capt
    # the big bar is only red when the limit is really reached
    for i in range(2):
        card = pg.locator(".capcard").nth(i)
        cls = card.locator(".track:not(.sm)").get_attribute("class")
        assert "red" not in cls, cls
    health = pg.inner_text(".card:has-text('Provider health')")
    assert "Ready" in health and "Error" in health and "Key rejected (401)" in health, health
    pg.screenshot(path=OUT + "-1-overview.png", full_page=True)

    # providers: status per provider, limits from headers, free/paid sheet
    pg.click(".side >> text=Providers")
    pg.wait_for_selector("text=Connect a provider")
    # rows start folded: details hidden until the row is opened
    def openp(name):
        c = pg.locator(".pcard", has=pg.locator("h3", has_text=name))
        if c.get_attribute("class").find(" open") < 0:
            c.locator(".ph").click()
        pg.wait_for_timeout(450)
        return c
    assert pg.locator(".pcard.open").count() == 0
    assert pg.locator(".pcard .fold[inert]").count() == pg.locator(".pcard").count()
    pg.screenshot(path=OUT + "-2a-folded.png", full_page=True)
    # search narrows the list
    total = pg.locator(".pcard").count()
    pg.fill("input[name=provider-search]", "gro")
    pg.wait_for_function("document.querySelectorAll('.pcard').length === 1")
    assert "groq" in pg.inner_text(".plist").lower()
    pg.fill("input[name=provider-search]", "zzz")
    pg.wait_for_selector(".plist .empty:has-text('No connected provider')")
    pg.fill("input[name=provider-search]", "")
    pg.wait_for_function("document.querySelectorAll('.pcard').length === %d" % total)
    groq = openp("groq")
    assert pg.get_attribute(".pcard.open .ph", "aria-expanded") == "true"
    gt = groq.inner_text()
    assert "Free model answered" in gt and "Key works" in gt and "Tokens left" in gt and "Reported by provider" in gt, gt
    mis = openp("mistral").inner_text()
    assert "Key rejected (401)" in mis and "No free models" not in mis, mis
    pg.screenshot(path=OUT + "-2-providers.png", full_page=True)
    orc = openp("openrouter")
    orc.locator("button.stat:has-text('Paid models')").click()
    pg.wait_for_selector(".sheet.on .li")
    sheet = pg.inner_text(".sheet")
    assert "openai/gpt-5" in sheet and "glm-5.3" not in sheet, sheet
    pg.click(".sheet .seg >> text=Free")
    pg.wait_for_selector(".sheet .li:has-text('glm-5.3')")
    pg.screenshot(path=OUT + "-3-sheet.png")
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(500)

    # connect a new provider through the UI: key is checked and a free model tested
    # key prefix is recognised without picking anything
    # one compact form: no wall of chips, no "Other" step
    assert pg.locator(".pchip").count() == 0
    assert pg.is_visible("input[name=custom-name]") and pg.is_visible("input[name=custom-url]")
    form = ".card:has-text('Connect a provider')"
    # key prefix is recognised: name and URL filled in, URL locked
    pg.fill("input[name=provider-key]", "gsk_example123")
    pg.wait_for_selector(".cinfo:has-text('Detected Groq')")
    assert pg.input_value("input[name=custom-name]") == "groq"
    assert pg.eval_on_selector("input[name=custom-url]", "e => e.readOnly && e.value.length > 0")
    assert pg.locator(form + " .acc.open").count() == 0
    # the provider list filters as you type and offers a new name
    pg.fill("input[name=custom-name]", "gro")
    pg.wait_for_selector(".combo-menu.on .dd-opt:has-text('groq')")
    pg.fill("input[name=custom-name]", "zenmux")
    pg.wait_for_selector(".combo-menu.on .dd-opt:has-text('Add \"zenmux\"')")
    pg.keyboard.press("Escape")
    pg.wait_for_selector(".combo-menu", state="detached")
    # unknown key: Connect waits for the base URL, pricing shows for a new provider
    pg.fill("input[name=provider-key]", "chutes-key-ffff6666")
    assert pg.is_disabled(form + " button:has-text('Connect')")
    pg.wait_for_selector(form + " .acc.open .bill-row")
    pg.fill("input[name=custom-url]", "http://127.0.0.1:9901")
    assert not pg.is_disabled(form + " button:has-text('Connect')")
    w = pg.eval_on_selector("input[name=custom-url]", "e => e.getBoundingClientRect().width")
    assert w > 200, w
    pg.screenshot(path=OUT + "-2b-connect.png")
    pg.click(".card:has-text('Connect a provider') button:has-text('Connect')")
    pg.wait_for_selector(".pcard:has(h3:has-text('zenmux')) .pill.ready", timeout=30000)
    pg.wait_for_selector(".toast:has-text('Zenmux')")
    # check now
    assert "open" in pg.locator(".pcard", has=pg.locator("h3", has_text="zenmux")).get_attribute("class")
    # free token allowance: paid models count as free, meter shown
    cl = openp("creditapi")
    clt = cl.inner_text()
    assert "credit" in clt and "Free tokens" in clt and "2 free" in clt and "count as free until this runs out" in clt and "Tokens today" in clt, clt
    # providers that need no key
    kl = pg.inner_text(".keyless")
    assert "No key needed" in kl and "Kilo" in kl and "Ovh" in kl, kl
    pg.screenshot(path=OUT + "-2c-credit.png", full_page=True)
    # Resets offers rolling 5, 9 and 12 hour windows
    cl.locator("button.acc-btn:has-text('Settings')").click()
    pg.wait_for_timeout(450)
    cl.locator(".dd-btn[aria-label='Free tokens reset']").click()
    opts = pg.inner_text(".dd-menu.on")
    assert "Every 5 hours" in opts and "Every 9 hours" in opts and "Every 12 hours" in opts, opts
    pg.keyboard.press("Escape")
    pg.wait_for_selector(".dd-menu", state="detached")
    # big numbers get thousands separators; 2m is shorthand for 2,000,000
    at = cl.locator("input[name=allow-tokens]")
    assert at.input_value() == "500,000", at.input_value()
    at.fill("")
    at.type("1250000")
    assert at.input_value() == "1,250,000", at.input_value()
    at.fill("")
    at.type("2m")
    assert at.input_value() == "2,000,000", at.input_value()
    at.fill("")
    at.type("500000")
    chu = pg.inner_text(".pcard:has(h3:has-text('zenmux'))")
    assert "Free model answered" in chu and "big-pickle" in chu and "1 free" in chu and "2 paid" in chu, chu
    pg.locator(".pcard", has=pg.locator("h3", has_text="zenmux")).locator("text=Check now").click()
    pg.wait_for_selector(".toast:has-text('free model')")

    # remove uses our own confirm popup; cancel keeps the key
    pg.locator(".pcard", has=pg.locator("h3", has_text="mistral")).locator("button[aria-label^='Remove key']").click()
    pg.wait_for_selector(".modal.on:has-text('Remove this key?')")
    pg.screenshot(path=OUT + "-2c-modal.png")
    pg.click(".modal >> text=Cancel")
    pg.wait_for_selector(".modal-wrap", state="detached")
    assert pg.locator(".pcard", has=pg.locator("h3", has_text="mistral")).count() == 1

    # models page: free/paid split
    pg.click(".side >> text=Models")
    pg.wait_for_selector("text=What \"auto\" picks right now")
    pg.wait_for_selector("tbody tr")
    rows = pg.inner_text("tbody")
    assert "openai/gpt-5" not in rows and "glm-5.3" in rows, rows[:300]
    pg.click(".card .seg >> text=Paid")
    pg.wait_for_selector("tbody tr:has-text('openai/gpt-5')")
    # KPI tiles stay their own size next to a long list
    hgt = pg.eval_on_selector(".kpi-row .kpi", "e => e.getBoundingClientRect().height")
    assert hgt < 260, hgt
    # cards sit side by side above the provider list
    pg.wait_for_timeout(900)
    k1 = pg.eval_on_selector_all(".kpi-row .kpi", "els => els.map(e => [e.getBoundingClientRect().top, e.getBoundingClientRect().bottom])")
    shr = pg.eval_on_selector(".card:has(h3:has-text('Free models by provider'))", "e => e.getBoundingClientRect().top")
    assert len(k1) == 2 and abs(k1[0][0] - k1[1][0]) < 2 and shr > k1[0][1], (k1, shr)
    # our own dropdown: opens, filters, closes on Escape
    pg.click(".dd-btn[aria-label='Provider']")
    pg.wait_for_selector(".dd-menu.on .dd-opt:has-text('Openrouter')")
    pg.screenshot(path=OUT + "-4b-dropdown.png")
    pg.click(".dd-menu .dd-opt:has-text('Openrouter')")
    pg.wait_for_selector(".dd-menu", state="detached")
    assert pg.inner_text(".dd-btn[aria-label='Provider']").strip() == "Openrouter"
    pg.click(".dd-btn[aria-label='Task']")
    pg.wait_for_selector(".dd-menu.on")
    pg.keyboard.press("ArrowDown")
    pg.keyboard.press("Escape")
    pg.wait_for_selector(".dd-menu", state="detached")
    pg.screenshot(path=OUT + "-4-models.png", full_page=True)

    # usage
    pg.click(".side >> text=Usage")
    pg.wait_for_selector("text=Top models")
    u = pg.inner_text(".page")
    assert "tokens" in u and "research-agent" in u, u[:300]
    pg.hover(".bar.today")
    pg.wait_for_selector(".tip.on:has-text('tokens')")
    pg.click(".seg >> text=Requests")
    pg.screenshot(path=OUT + "-5-usage.png", full_page=True)

    # agent keys: create with paid toggle
    pg.click(".side >> text=Agent keys")
    pg.wait_for_selector("text=Create a key")
    assert pg.get_attribute("input[name=cap]", "inputmode") == "numeric"
    pg.type("input[name=cap]", "25000")
    assert pg.input_value("input[name=cap]") == "25,000"
    pg.fill("input[name=cap]", "")
    pg.fill("input[name=agent]", "researcher")
    pg.click(".card:has-text('Create a key') .switch")
    pg.wait_for_selector("text=On: free first")
    pg.click("text=Create key")
    pg.wait_for_selector("text=Copy this key now")
    assert "sk-router-" in pg.inner_text(".reveal")
    pg.wait_for_selector("td:has-text('researcher')")
    pg.screenshot(path=OUT + "-6-keys.png", full_page=True)

    # playground
    pg.click(".side >> text=Playground")
    pg.click("button:has-text('Send')")
    pg.wait_for_selector(".pill:has-text('Answered')", timeout=30000)
    pg.screenshot(path=OUT + "-7-playground.png", full_page=True)

    # settings: mode change shows in sidebar, routes JSON validation
    pg.click(".side >> text=Settings")
    pg.wait_for_selector("text=Wait for a free slot (seconds)")
    pg.click(".seg >> text=Free first, then paid")
    pg.click("button:has-text('Save')")
    pg.wait_for_selector(".side-mode:has-text('Free first, then paid')")
    pg.click("text=Edit custom routes (JSON)")
    pg.fill("textarea", "{ not json")
    pg.click("text=Save routes")
    pg.wait_for_selector("text=JSON error")
    pg.fill("textarea", '{ "auto": [ { "provider": "groq", "model": "x" } ] }')
    pg.click("text=Save routes")
    pg.wait_for_selector(".err:has-text('reserved')")
    errors[:] = [e for e in errors if not ("HTTP 400 PUT" in e and "/admin/routes" in e) and "status of 400" not in e]
    pg.screenshot(path=OUT + "-8-settings.png", full_page=True)

    # dark mode: toggle, persists across reload
    pg.click(".side >> text=Dark mode")
    assert pg.get_attribute("html", "data-theme") == "dark"
    pg.click(".side >> .nav-btn >> nth=0")
    pg.wait_for_selector("text=Tokens per day")
    pg.wait_for_timeout(400)
    pg.screenshot(path=OUT + "-10-dark-overview.png", full_page=True)
    pg.reload()
    pg.wait_for_selector("text=Tokens per day")
    assert pg.get_attribute("html", "data-theme") == "dark"
    pg.click(".side >> text=Providers")
    pg.wait_for_selector("text=Connect a provider")
    pg.wait_for_timeout(400)
    pg.screenshot(path=OUT + "-11-dark-providers.png", full_page=True)
    pg.click(".side >> text=Models")
    pg.wait_for_selector("tbody tr")
    pg.screenshot(path=OUT + "-12-dark-models.png", full_page=True)
    assert pg.evaluate("getComputedStyle(document.documentElement).colorScheme") == "dark"
    pg.click(".side >> text=Light mode")
    assert pg.get_attribute("html", "data-theme") == "light"
    # native parts (scrollbars, pickers) follow the chosen theme, not the system one
    assert pg.evaluate("getComputedStyle(document.documentElement).colorScheme") == "light"

    # discover: directory cards with card rules, limits and a create-account link; Add fills the connect form
    pg.click(".side >> .nav-btn[data-tip='Discover']")
    pg.wait_for_selector(".dcard")
    dt = pg.inner_text(".dgrid")
    assert "NVIDIA NIM" in dt and "Phone verification" in dt and "No card" in dt and "Create account" in dt and "Not OpenAI-compatible" in dt, dt
    assert pg.locator(".dcard:has-text('OpenRouter') .pill.ready").count() == 1
    pg.wait_for_timeout(500)
    pg.screenshot(path=OUT + "-16-discover.png", full_page=True)
    pg.locator(".dcard", has=pg.locator("h3", has_text="LLM7.io")).locator("button:has-text('Add')").click()
    pg.wait_for_selector(".card.connect")
    assert pg.input_value("input[name=custom-name]") == "llm7-io"
    assert pg.input_value("input[name=custom-url]") == "https://api.llm7.io/v1"
    assert pg.input_value("input[name=custom-docs]") == "https://token.llm7.io"
    pg.screenshot(path=OUT + "-17-prefill.png")
    # models page: benchmark source bar and a source tag on every score
    pg.click(".side >> .nav-btn[data-tip='Models']")
    pg.wait_for_selector(".card.bench")
    assert "LMArena" in pg.inner_text(".card.bench")
    assert pg.locator("td .src").count() > 0
    # provider logos: initials or an image, never empty
    pg.click(".side >> .nav-btn >> nth=0")
    pg.wait_for_selector(".plogo")
    assert all(len(t) or pg.locator(".plogo.img").count() for t in pg.locator(".plogo").all_inner_texts())
    # collapsible sidebar: narrow rail, round buttons, remembered after reload
    pg.click(".side-fold")
    pg.wait_for_timeout(450)
    sw = pg.eval_on_selector(".side", "e => e.getBoundingClientRect().width")
    assert sw < 100, sw
    nb = pg.eval_on_selector(".side .nav-btn", "e => [e.getBoundingClientRect().width, e.getBoundingClientRect().height]")
    assert abs(nb[0] - nb[1]) < 1, nb
    pg.hover(".side .nav-btn >> nth=1")
    pg.wait_for_timeout(250)
    assert pg.is_visible(".rtip.on") and pg.inner_text(".rtip") == "Providers", pg.inner_text(".rtip")
    # the rail buttons are true circles
    r = pg.eval_on_selector_all(".side .nav-btn", "els => els.map(e => [e.getBoundingClientRect().width, e.getBoundingClientRect().height])")
    assert all(abs(w - h) < 1 and w == 48 for w, h in r), r
    assert not pg.is_visible(".side-mode"), "routing dot hidden in the rail"
    pg.screenshot(path=OUT + "-13-mini.png")
    pg.click(".side >> .nav-btn[data-tip='Models']")
    pg.wait_for_selector(".card.bench")
    pg.wait_for_timeout(900)
    pg.screenshot(path=OUT + "-14-mini-models.png", full_page=True)
    pg.click(".side >> .nav-btn[data-tip='Providers']")
    pg.wait_for_selector(".pcard")
    pg.wait_for_timeout(1500)
    pg.screenshot(path=OUT + "-15-mini-providers.png", full_page=True)
    pg.click(".side >> .nav-btn >> nth=0")
    pg.reload()
    pg.wait_for_selector(".shell.mini")
    pg.click(".side-fold")
    pg.wait_for_timeout(450)
    assert pg.eval_on_selector(".side", "e => e.getBoundingClientRect().width") > 200
    # provider key boxes must not get the saved admin key autofilled
    pg.click(".side >> .nav-btn[data-tip='Providers']")
    pg.wait_for_selector("input[name=provider-key]")
    assert pg.get_attribute("input[name=provider-key]", "autocomplete") == "new-password"

    # mobile width still usable
    pg.set_viewport_size({"width": 420, "height": 900})
    pg.click(".side >> .nav-btn >> nth=0")
    pg.wait_for_selector("text=Tokens per day")
    pg.screenshot(path=OUT + "-9-mobile.png", full_page=True)
    br.close()

# web fonts come from Google Fonts and cdnfonts; this sandbox has no route to them
errors[:] = [e for e in errors if "Failed to load resource: net::" not in e and "fonts." not in e]
print("\n".join(errors) if errors else "no browser errors")
assert not errors
print("UI CHECK PASSED")
