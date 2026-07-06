using ReCharacter.RulesEngine;

namespace ReCharacter.RulesEngine.Tests;

public sealed class FakeClock(DateOnly today) : IClock
{
    public DateOnly Today { get; } = today;
}
