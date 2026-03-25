#!/usr/bin/env python3
"""
Remove dead Telegram + Cloud API code from chatCoreRoutes.js
Creates a cleaned version preserving only Baileys-related code.
Uses precise line-by-line matching approach.
"""

INPUT = '/home/ubuntu/programas/mprWA/backend/chatCoreRoutes.js'
OUTPUT = INPUT  # Overwrite original

with open(INPUT, 'r', encoding='utf-8') as f:
    lines = f.readlines()

total = len(lines)
print(f"Original: {total} lines")

keep = [True] * total

def mark_remove(start, end):
    """Mark lines start..end (1-based, inclusive) for removal"""
    for i in range(start - 1, min(end, total)):
        keep[i] = False

def find_line(pattern, start_line=1):
    """Find line number (1-based) matching pattern"""
    for i in range(start_line - 1, total):
        if pattern in lines[i]:
            return i + 1
    return None

def find_route_end(start_line):
    """Find the closing });  of an app.get/post route starting at start_line (1-based).
    Routes are at indent level 2 (2 spaces) inside registerChatCoreRoutes function.
    We look for a line that is exactly '  });' which closes the route handler."""
    for i in range(start_line, total):
        stripped = lines[i].rstrip('\n')
        if stripped == '  });':
            return i + 1  # 1-based
    return None

def find_const_fn_end(start_line):
    """Find the end of a const fn = async (...) => { ... }; at indent level 2.
    Look for line matching '  };' """
    # Count braces to handle nesting
    depth = 0
    for i in range(start_line - 1, total):
        for ch in lines[i]:
            if ch == '{': depth += 1
            elif ch == '}': depth -= 1
        if depth == 0:
            return i + 1  # 1-based
    return None

# ============================================================
# SECTION 1: Remove Telegram imports (lines 5-7)
# ============================================================
mark_remove(5, 7)
print("Removed: Telegram imports (lines 5-7)")

# ============================================================
# SECTION 2: Remove Telegram deps (lines 14-20)
# ============================================================
mark_remove(14, 20)
print("Removed: Telegram deps destructuring (lines 14-20)")

# ============================================================  
# SECTION 3: Remove normalizePath + telegram webhook setup (lines 53-60)
# ============================================================
mark_remove(53, 60)
print("Removed: Telegram webhook path setup (lines 53-60)")

# ============================================================
# SECTION 4: Remove isCloudWhatsAppProvider + telegram normalizers (lines 61-63)
# ============================================================
mark_remove(61, 63)
print("Removed: isCloudWhatsAppProvider + telegram normalizers (lines 61-63)")

# ============================================================
# SECTION 5: Remove hasTelegramBot + telegram constants + state (lines 91-107)
# ============================================================
mark_remove(91, 107)
print("Removed: Telegram constants and state vars (lines 91-107)")

# ============================================================
# SECTION 6: Remove ALL Telegram functions (lines 588-1708)
# From describeTelegramUserError() through dispatchTelegramUserOutbound()
# loadConversationContextById is USED by the send route - KEEP it
# isTelegramCustomerRecord / hasTelegramTrafficForNumber / hasTelegramVerifiedForNumber - REMOVE
# sendTelegramApiRequest - REMOVE
# ============================================================
# Remove from describeTelegramUserError (588) to just before streamClients (1709)
# But KEEP loadConversationContextById (1415-1458)
mark_remove(588, 1414)  # describeTelegramUserError through sendTelegramApiRequest + isTelegramCustomerRecord
print("Removed: Telegram functions part 1 (lines 588-1414)")

# loadConversationContextById is at 1415-1458 - KEEP IT

mark_remove(1460, 1708)  # hasTelegramTrafficForNumber through dispatchTelegramUserOutbound  
print("Removed: Telegram functions part 2 (lines 1460-1708)")

# ============================================================
# SECTION 7: Remove Cloud API webhook GET + POST (lines 1743-1979)
# ============================================================
webhook_get_start = find_line("app.get(['/webhook', '/webhook/whatsapp']")
webhook_post_start = find_line("app.post(['/webhook', '/webhook/whatsapp']")
if webhook_get_start and webhook_post_start:
    # Find end of the POST handler
    post_end = find_route_end(webhook_post_start)
    if post_end:
        mark_remove(webhook_get_start, post_end)
        print(f"Removed: Cloud API webhooks (lines {webhook_get_start}-{post_end})")

# ============================================================
# SECTION 8: Remove ALL Telegram routes
# From /api/telegram/health through /webhook/telegram POST
# ============================================================
tg_health = find_line("app.get(['/api/telegram/health'")
if tg_health:
    tg_webhook = find_line("app.post(telegramWebhookRoutes", tg_health)
    if tg_webhook:
        tg_end = find_route_end(tg_webhook)
        if tg_end:
            mark_remove(tg_health, tg_end)
            print(f"Removed: Telegram routes (lines {tg_health}-{tg_end})")

# ============================================================
# SECTION 9: Remove /api/telegram/customers route
# ============================================================
tg_cust = find_line("app.get(['/api/telegram/customers'")
if tg_cust:
    tg_cust_end = find_route_end(tg_cust)
    if tg_cust_end:
        mark_remove(tg_cust, tg_cust_end)
        print(f"Removed: Telegram customers route (lines {tg_cust}-{tg_cust_end})")

# Write cleaned file
cleaned = []
for i, line in enumerate(lines):
    if keep[i]:
        cleaned.append(line)

with open(OUTPUT, 'w', encoding='utf-8') as f:
    f.writelines(cleaned)

removed = sum(1 for k in keep if not k)
print(f"\nTotal removed: {removed} lines")
print(f"Final: {len(cleaned)} lines")
print(f"Written to: {OUTPUT}")
