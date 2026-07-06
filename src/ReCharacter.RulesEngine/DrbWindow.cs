namespace ReCharacter.RulesEngine;

/// <summary>
/// The Discharge Review Board can review a discharge only if the application is made
/// within 15 years of the discharge date. The deadline day itself is inclusive.
/// </summary>
public static class DrbWindow
{
    public const int Years = 15;

    public static DateOnly Deadline(DateOnly dischargeDate) => dischargeDate.AddYears(Years);

    public static bool IsOpen(DateOnly dischargeDate, DateOnly asOf) => asOf <= Deadline(dischargeDate);
}
