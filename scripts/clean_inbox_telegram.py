#!/usr/bin/env python3
"""Remove Telegram dead code from Inbox.tsx - surgical cleanup."""
import re

INPUT = '/home/ubuntu/programas/mprWA/pages/Inbox.tsx'
OUTPUT = INPUT  # overwrite

with open(INPUT, 'r', encoding='utf-8') as f:
    src = f.read()

lines = src.split('\n')

# === 1. Remove Telegram imports (lines 23-30) ===
telegram_imports = [
    '  fetchTelegramContactStatuses,',
    '  checkTelegramContacts,',
    '  fetchTelegramUserHealth,',
    '  telegramUserSendCode,',
    '  telegramUserVerifyCode,',
    '  telegramUserVerifyPassword,',
    '  TelegramContactStatusRow,',
    '  TelegramUserAuthStatus,',
]
for imp in telegram_imports:
    if imp in lines:
        lines.remove(imp)

# === 2. Replace Telegram state variables with stub defaults ===
telegram_state_lines = []
for i, line in enumerate(lines):
    stripped = line.strip()
    # Match useState lines containing telegram-related names
    if any(x in stripped for x in [
        'telegramUserAuth', 'telegramStatusByDigits', 'isConnectingTelegramUser',
        'isCheckingTelegramContacts', 'contactsTelegramOnly', 'showTelegramAuthModal',
        'telegramAuthStep', 'telegramAuthPhone', 'telegramAuthCode',
        'telegramAuthPassword', 'telegramAuthInfo', 'telegramAuthError',
        'telegramOnly, setTelegramOnly',
    ]) and 'useState' in stripped:
        telegram_state_lines.append(i)

# Remove these state lines
for i in sorted(telegram_state_lines, reverse=True):
    del lines[i]

# === 3. Remove function blocks - find start and matching closing ===
def remove_function_block(lines_list, start_pattern, end_offset_hint=None):
    """Remove a function/callback block from lines_list by finding balanced braces."""
    for i, line in enumerate(lines_list):
        if start_pattern in line:
            # Find the end by counting braces
            brace_count = 0
            started = False
            end_i = i
            for j in range(i, len(lines_list)):
                for char in lines_list[j]:
                    if char == '{':
                        brace_count += 1
                        started = True
                    elif char == '}':
                        brace_count -= 1
                if started and brace_count == 0:
                    end_i = j
                    break
            
            # Check if next line after end is a semicolon or closing
            if end_i + 1 < len(lines_list) and lines_list[end_i + 1].strip() in [')', ');', '};', ']);']:
                end_i += 1
            
            # Remove the block
            del lines_list[i:end_i + 1]
            return True
    return False

# Remove Telegram callback functions
callbacks_to_remove = [
    'const mergeTelegramStatusRows = useCallback',
    'const refreshTelegramStatuses = useCallback',
    'const refreshTelegramAuth = useCallback',
    'const handleConnectTelegramUser = async',
    'const handleTelegramAuthSendCode = async',
    'const handleTelegramAuthVerifyCode = async',
    'const handleTelegramAuthVerifyPassword = async',
    'const handleCheckTelegramContacts = async',
    'const handleRequestTelegramContact = async',
]

for pattern in callbacks_to_remove:
    removed = remove_function_block(lines, pattern)
    if removed:
        print(f"  Removed: {pattern}")
    else:
        print(f"  NOT FOUND: {pattern}")

# === 4. Replace telegramConversations useMemo with empty stubs ===
for i, line in enumerate(lines):
    if 'const telegramConversations = useMemo(' in line:
        # Find end of this useMemo
        brace_count = 0
        started = False
        end_i = i
        for j in range(i, len(lines)):
            for char in lines[j]:
                if char == '{':
                    brace_count += 1
                    started = True
                elif char == '}':
                    brace_count -= 1
            if started and brace_count == 0:
                end_i = j
                break
        # Check for closing ), [deps]);
        while end_i + 1 < len(lines) and lines[end_i + 1].strip() in ['', '});', '], [chatContacts]);', ');']:
            end_i += 1
            if lines[end_i].strip().endswith(');'):
                break
        
        # Replace with empty stub
        indent = '  '
        replacement = [
            f"{indent}const telegramConversations = useMemo(() => ({{",
            f"{indent}  byConversationId: new Set<string>(),",
            f"{indent}  byCustomerId: new Set<string>(),",
            f"{indent}  byPhoneDigits: new Set<string>(),",
            f"{indent}}}), []);",
        ]
        lines[i:end_i + 1] = replacement
        print("  Replaced telegramConversations with empty stub")
        break

# === 5. Replace telegramCustomerIds useMemo with empty stub ===
for i, line in enumerate(lines):
    if 'const telegramCustomerIds = useMemo(' in line:
        brace_count = 0
        started = False
        end_i = i
        for j in range(i, len(lines)):
            for char in lines[j]:
                if char == '{':
                    brace_count += 1
                    started = True
                elif char == '}':
                    brace_count -= 1
            if started and brace_count == 0:
                end_i = j
                break
        while end_i + 1 < len(lines) and not lines[end_i].strip().endswith(');'):
            end_i += 1
        
        replacement = [
            f"  const telegramCustomerIds = useMemo(() => new Set<string>(), []);",
        ]
        lines[i:end_i + 1] = replacement
        print("  Replaced telegramCustomerIds with empty stub")
        break

# === 6. Simplify isTelegramConversation to always return false ===
for i, line in enumerate(lines):
    if 'const isTelegramConversation = (' in line:
        brace_count = 0
        started = False
        end_i = i
        for j in range(i, len(lines)):
            for char in lines[j]:
                if char == '{':
                    brace_count += 1
                    started = True
                elif char == '}':
                    brace_count -= 1
            if started and brace_count == 0:
                end_i = j
                break
        if end_i + 1 < len(lines) and lines[end_i + 1].strip() == ';':
            end_i += 1
        
        replacement = [
            f"  const isTelegramConversation = (_conversation: Conversation): boolean => false;",
        ]
        lines[i:end_i + 1] = replacement
        print("  Replaced isTelegramConversation with false stub")
        break

# === 7. Remove Telegram auth modal block (showTelegramAuthModal && ...) ===
for i, line in enumerate(lines):
    if '{showTelegramAuthModal && (' in line.strip():
        # Find matching close - this is JSX so count parens
        depth = 0
        started = False
        end_i = i
        for j in range(i, len(lines)):
            for char in lines[j]:
                if char == '(':
                    depth += 1
                    started = True
                elif char == ')':
                    depth -= 1
            if started and depth == 0:
                end_i = j
                break
        # Include the closing )}
        if end_i + 1 < len(lines) and lines[end_i + 1].strip() == ')}':
            end_i += 1
        del lines[i:end_i + 1]
        print("  Removed Telegram auth modal block")
        break

# === 8. Remove telegramConversationCount ===
for i, line in enumerate(lines):
    if 'const telegramConversationCount = conversations.filter' in line:
        # This spans a few lines
        end_i = i
        for j in range(i, min(i + 10, len(lines))):
            if lines[j].strip().endswith(');'):
                end_i = j
                break
        del lines[i:end_i + 1]
        print("  Removed telegramConversationCount")
        break

# === 9. Remove isTelegramCustomer and formatTelegramChatId utility functions ===
for i, line in enumerate(lines):
    if 'const isTelegramCustomer = (' in line:
        end_i = i
        for j in range(i, min(i + 10, len(lines))):
            if lines[j].strip().endswith('};') or (lines[j].strip() == '}' and j > i):
                end_i = j
                break
        del lines[i:end_i + 1]
        print("  Removed isTelegramCustomer")
        break

for i, line in enumerate(lines):
    if 'const formatTelegramChatId = ' in line:
        del lines[i]
        print("  Removed formatTelegramChatId")
        break

# === 10. Clean up remaining Telegram references in JSX/logic ===
result = '\n'.join(lines)

# Remove telegramStatuses from Promise.all destructuring and call
result = result.replace(
    'telegramStatuses, whatsappHealth',
    'whatsappHealth'
)
result = result.replace(
    "      fetchTelegramContactStatuses().catch(() => null),\n",
    ""
)

# Remove telegramStatuses processing block
result = re.sub(
    r'\s*if \(telegramStatuses\) \{[^}]+setTelegramUserAuth[^}]+setTelegramStatusByDigits[^}]+\}\s*\n',
    '\n',
    result,
    flags=re.DOTALL
)

# Remove telegramOnly prop passing and related props
result = result.replace('        telegramOnly={telegramOnly}\n', '')
result = result.replace('        telegramCount={telegramConversationCount}\n', '')
result = result.replace("        onToggleTelegramOnly={() => setTelegramOnly((previous) => !previous)}\n", '')

# Remove isTelegramConversation prop
result = re.sub(
    r'\s*isTelegramConversation=\{selectedConversation \? isTelegramConversation\(selectedConversation\) : false\}',
    '',
    result
)

# Remove onRequestTelegramContact prop
result = result.replace('            onRequestTelegramContact={handleRequestTelegramContact}\n', '')

# Replace isTelegramCustomer references with false
result = result.replace("isTelegramCustomer(selectedCustomer)", "false")
result = result.replace("isTelegramCustomer(customer)", "false")
result = result.replace("isTelegramCustomer(selectedCustomer) ? 'ID Telegram' : 'Telefone'", "'Telefone'")

# Remove telegramOnly filter from conversation filtering
result = result.replace("    if (telegramOnly && !isTelegramConversation(c)) return false;\n", "")

# Remove Telegram filter in contacts
result = result.replace("      if (contactsTelegramOnly && !row.hasTelegram) return false;\n", "")

# Simplify conversationChannelById to always return whatsapp 
# (but keep the structure since it's used elsewhere)
result = re.sub(
    r"const conversationChannelById = useMemo\(\(\) => \{.*?\}, \[conversations, chatContacts, telegramConversations\]\);",
    """const conversationChannelById = useMemo(() => {
    const map: Record<string, 'whatsapp'> = {};
    conversations.forEach((conversation) => {
      const conversationId = String(conversation.id || '').trim();
      if (conversationId) map[conversationId] = 'whatsapp';
    });
    return map;
  }, [conversations]);""",
    result,
    flags=re.DOTALL
)

# Remove hasTelegram from row
result = result.replace("      .filter((row) => row.rawPhone || row.hasTelegram)", "      .filter((row) => row.rawPhone)")
result = re.sub(r", \[customers, telegramCustomerIds, telegramStatusByDigits, chatContacts\]", ", [customers, chatContacts]", result)

# Remove Telegram-specific columns from contacts table
result = result.replace("                    <th className=\"px-4 py-2 text-[11px] uppercase tracking-wide text-gray-500\">Telegram</th>\n", "")

# Clean up contact row Telegram indicator columns - these are complex JSX blocks
# We'll handle these with more targeted regex

with open(OUTPUT, 'w', encoding='utf-8') as f:
    f.write(result)

new_count = result.count('\n') + 1
print(f"\nDone! Output: {OUTPUT}")
print(f"New line count: {new_count}")
