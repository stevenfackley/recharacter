namespace ReCharacter.RulesEngine;

public interface IClock
{
    DateOnly Today { get; }
}

/// <summary>
/// Resolves "today" as the current civil date in the westernmost inhabited U.S. time zone
/// (UTC-11, American Samoa). This is deliberately the most generous U.S. date: it guarantees
/// the engine never reports a filing window as closed while it is still open for any veteran
/// residing anywhere in the U.S. A false "you are too late" is the most harmful error this tool
/// can make, so the DRB-window math errs toward keeping the window open. Raw UTC would do the
/// opposite — rolling to "tomorrow" hours before any U.S. veteran's local midnight. When per-user
/// location is available (later plans), replace this with the veteran's own time zone.
/// </summary>
public sealed class SystemClock : IClock
{
    private static readonly TimeSpan WesternmostUsOffset = TimeSpan.FromHours(-11);

    public DateOnly Today =>
        DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(WesternmostUsOffset).DateTime);
}
