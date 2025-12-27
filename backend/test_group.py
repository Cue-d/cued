import core

# Test group chat sending with chat identifier
result = core.send_to_group("chat517699978504989836", "Test message from updated code!")
print(f"Success: {result.success}")
if result.error:
    print(f"Error: {result.error}")
