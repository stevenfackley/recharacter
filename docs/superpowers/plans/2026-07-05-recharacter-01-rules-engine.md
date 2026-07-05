# Rules Engine + Routing API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stateless service that turns discharge facts (branch, discharge date, characterization, court-martial flag) into the correct review board, application form, DRB filing deadline, and advisory flags.

**Architecture:** A pure `ReCharacter.RulesEngine` .NET class library (no I/O, no clock reads, no persistence) wrapped by a thin ASP.NET minimal API (`ReCharacter.RoutingApi`) exposing `POST /route`. All time-dependent logic goes through an injected `IClock`, so the 15-year DRB-window boundary is tested deterministically. Next.js will call this API later; this plan delivers the callable service and its tests.

**Tech Stack:** .NET 10, C# 14, xUnit, ASP.NET Core minimal API, `Microsoft.AspNetCore.Mvc.Testing` for integration tests.

**Domain facts encoded here (do not re-derive during implementation):**
- The **DRB** (Discharge Review Board) can review a discharge only if applied for **within 15 years of the discharge date**; it uses **DD Form 293**.
- The **BCMR** (Board for Correction of Military/Naval Records) handles everything else — beyond 15 years, or corrections the DRB can't make; it uses **DD Form 149**. Its 3-year statutory filing limit is routinely waived in the interest of justice, so BCMR is treated as **always available** (with an advisory flag), never hard-closed.
- The **DRB cannot review a discharge that resulted from a general court-martial** — those must go to the BCMR.
- Branch → board names: Army = ADRB/ABCMR; Navy & Marine Corps = NDRB/BCNR; Air Force & Space Force = AFDRB/AFBCMR; Coast Guard = CGDRB/BCMR (DHS). Coast Guard is under DHS and its liberal-consideration policy is analogous but not identical — flag it.

---

## File structure

Library (`src/ReCharacter.RulesEngine/`):
- `DischargeTypes.cs` — `Branch`, `DischargeCharacterization` enums.
- `RoutingTypes.cs` — `ReviewBoard`, `ApplicationForm`, `RoutingFlag` enums.
- `DischargeFacts.cs` — input record.
- `RoutingResult.cs` — output record.
- `IClock.cs` — `IClock` interface + `SystemClock`.
- `BoardDirectory.cs` — `BoardNames` record + `BoardDirectory` branch→names lookup.
- `DrbWindow.cs` — deadline + window-open math.
- `DischargeRouter.cs` — orchestrates the above into a `RoutingResult`.

API (`src/ReCharacter.RoutingApi/`):
- `Program.cs` — minimal API, DI registration, `POST /route`.

Tests (`tests/ReCharacter.RulesEngine.Tests/`):
- `FakeClock.cs` — deterministic test clock.
- `BoardDirectoryTests.cs`
- `DrbWindowTests.cs`
- `DischargeRouterTests.cs`

Tests (`tests/ReCharacter.RoutingApi.Tests/`):
- `RouteEndpointTests.cs` — integration test via `WebApplicationFactory`.

---

## Task 0: Scaffold the solution and projects

**Files:**
- Create: `ReCharacter.sln`, `src/ReCharacter.RulesEngine/ReCharacter.RulesEngine.csproj`, `src/ReCharacter.RoutingApi/ReCharacter.RoutingApi.csproj`, `tests/ReCharacter.RulesEngine.Tests/ReCharacter.RulesEngine.Tests.csproj`, `tests/ReCharacter.RoutingApi.Tests/ReCharacter.RoutingApi.Tests.csproj`

- [ ] **Step 1: Create solution and projects**

Run from repo root (`C:\Users\steve\projects\recharacter`):

```bash
dotnet new sln -n ReCharacter
dotnet new classlib -n ReCharacter.RulesEngine -o src/ReCharacter.RulesEngine -f net10.0
dotnet new web -n ReCharacter.RoutingApi -o src/ReCharacter.RoutingApi -f net10.0
dotnet new xunit -n ReCharacter.RulesEngine.Tests -o tests/ReCharacter.RulesEngine.Tests -f net10.0
dotnet new xunit -n ReCharacter.RoutingApi.Tests -o tests/ReCharacter.RoutingApi.Tests -f net10.0
```

Delete the template `Class1.cs`:

```bash
rm src/ReCharacter.RulesEngine/Class1.cs
```

- [ ] **Step 2: Wire references and add projects to the solution**

```bash
dotnet add tests/ReCharacter.RulesEngine.Tests reference src/ReCharacter.RulesEngine
dotnet add src/ReCharacter.RoutingApi reference src/ReCharacter.RulesEngine
dotnet add tests/ReCharacter.RoutingApi.Tests reference src/ReCharacter.RoutingApi
dotnet add tests/ReCharacter.RoutingApi.Tests package Microsoft.AspNetCore.Mvc.Testing
dotnet sln add src/ReCharacter.RulesEngine src/ReCharacter.RoutingApi tests/ReCharacter.RulesEngine.Tests tests/ReCharacter.RoutingApi.Tests
```

- [ ] **Step 3: Verify the solution builds**

Run: `dotnet build`
Expected: `Build succeeded` with 0 errors (warnings about the empty test classes are fine).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: scaffold ReCharacter solution (rules engine + routing api + tests)"
```

---

## Task 1: BoardDirectory (branch → board names)

**Files:**
- Create: `src/ReCharacter.RulesEngine/DischargeTypes.cs`
- Create: `src/ReCharacter.RulesEngine/BoardDirectory.cs`
- Test: `tests/ReCharacter.RulesEngine.Tests/BoardDirectoryTests.cs`

- [ ] **Step 1: Write the failing test**

`tests/ReCharacter.RulesEngine.Tests/BoardDirectoryTests.cs`:

```csharp
using ReCharacter.RulesEngine;
using Xunit;

namespace ReCharacter.RulesEngine.Tests;

public class BoardDirectoryTests
{
    [Theory]
    [InlineData(Branch.Army, "ADRB", "ABCMR")]
    [InlineData(Branch.Navy, "NDRB", "BCNR")]
    [InlineData(Branch.MarineCorps, "NDRB", "BCNR")]
    [InlineData(Branch.AirForce, "AFDRB", "AFBCMR")]
    [InlineData(Branch.SpaceForce, "AFDRB", "AFBCMR")]
    [InlineData(Branch.CoastGuard, "CGDRB", "BCMR (DHS)")]
    public void For_ReturnsCorrectBoardNames(Branch branch, string drb, string bcmr)
    {
        var names = BoardDirectory.For(branch);

        Assert.Equal(drb, names.DrbName);
        Assert.Equal(bcmr, names.BcmrName);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/ReCharacter.RulesEngine.Tests --filter BoardDirectoryTests`
Expected: FAIL — compile error, `Branch` and `BoardDirectory` do not exist.

- [ ] **Step 3: Write minimal implementation**

`src/ReCharacter.RulesEngine/DischargeTypes.cs`:

```csharp
namespace ReCharacter.RulesEngine;

public enum Branch
{
    Army,
    Navy,
    MarineCorps,
    AirForce,
    SpaceForce,
    CoastGuard
}

public enum DischargeCharacterization
{
    Honorable,
    GeneralUnderHonorable,
    OtherThanHonorable,
    BadConductDischarge,
    DishonorableDischarge,
    Uncharacterized
}
```

`src/ReCharacter.RulesEngine/BoardDirectory.cs`:

```csharp
namespace ReCharacter.RulesEngine;

public sealed record BoardNames(string DrbName, string BcmrName);

public static class BoardDirectory
{
    public static BoardNames For(Branch branch) => branch switch
    {
        Branch.Army => new BoardNames("ADRB", "ABCMR"),
        Branch.Navy or Branch.MarineCorps => new BoardNames("NDRB", "BCNR"),
        Branch.AirForce or Branch.SpaceForce => new BoardNames("AFDRB", "AFBCMR"),
        Branch.CoastGuard => new BoardNames("CGDRB", "BCMR (DHS)"),
        _ => throw new ArgumentOutOfRangeException(nameof(branch), branch, "Unknown branch")
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/ReCharacter.RulesEngine.Tests --filter BoardDirectoryTests`
Expected: PASS — 6 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/ReCharacter.RulesEngine/DischargeTypes.cs src/ReCharacter.RulesEngine/BoardDirectory.cs tests/ReCharacter.RulesEngine.Tests/BoardDirectoryTests.cs
git commit -m "feat: add branch-to-board directory"
```

---

## Task 2: DrbWindow (the 15-year boundary math)

**Files:**
- Create: `src/ReCharacter.RulesEngine/DrbWindow.cs`
- Test: `tests/ReCharacter.RulesEngine.Tests/DrbWindowTests.cs`

- [ ] **Step 1: Write the failing test**

`tests/ReCharacter.RulesEngine.Tests/DrbWindowTests.cs`:

```csharp
using ReCharacter.RulesEngine;
using Xunit;

namespace ReCharacter.RulesEngine.Tests;

public class DrbWindowTests
{
    [Fact]
    public void Deadline_IsExactlyFifteenYearsAfterDischarge()
    {
        var discharge = new DateOnly(2010, 3, 14);

        Assert.Equal(new DateOnly(2025, 3, 14), DrbWindow.Deadline(discharge));
    }

    [Fact]
    public void IsOpen_DayBeforeDeadline_True()
    {
        var discharge = new DateOnly(2010, 3, 14);
        var asOf = new DateOnly(2025, 3, 13); // one day before the 15-year mark

        Assert.True(DrbWindow.IsOpen(discharge, asOf));
    }

    [Fact]
    public void IsOpen_OnDeadlineDay_True_Inclusive()
    {
        var discharge = new DateOnly(2010, 3, 14);
        var asOf = new DateOnly(2025, 3, 14); // exactly 15 years later

        Assert.True(DrbWindow.IsOpen(discharge, asOf));
    }

    [Fact]
    public void IsOpen_DayAfterDeadline_False()
    {
        var discharge = new DateOnly(2010, 3, 14);
        var asOf = new DateOnly(2025, 3, 15); // one day past the 15-year mark

        Assert.False(DrbWindow.IsOpen(discharge, asOf));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/ReCharacter.RulesEngine.Tests --filter DrbWindowTests`
Expected: FAIL — compile error, `DrbWindow` does not exist.

- [ ] **Step 3: Write minimal implementation**

`src/ReCharacter.RulesEngine/DrbWindow.cs`:

```csharp
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/ReCharacter.RulesEngine.Tests --filter DrbWindowTests`
Expected: PASS — 4 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/ReCharacter.RulesEngine/DrbWindow.cs tests/ReCharacter.RulesEngine.Tests/DrbWindowTests.cs
git commit -m "feat: add DRB 15-year filing window math"
```

---

## Task 3: DischargeRouter — happy path (within-window admin separation)

**Files:**
- Create: `src/ReCharacter.RulesEngine/RoutingTypes.cs`
- Create: `src/ReCharacter.RulesEngine/DischargeFacts.cs`
- Create: `src/ReCharacter.RulesEngine/RoutingResult.cs`
- Create: `src/ReCharacter.RulesEngine/IClock.cs`
- Create: `src/ReCharacter.RulesEngine/DischargeRouter.cs`
- Create: `tests/ReCharacter.RulesEngine.Tests/FakeClock.cs`
- Test: `tests/ReCharacter.RulesEngine.Tests/DischargeRouterTests.cs`

- [ ] **Step 1: Write the failing test**

`tests/ReCharacter.RulesEngine.Tests/FakeClock.cs`:

```csharp
using ReCharacter.RulesEngine;

namespace ReCharacter.RulesEngine.Tests;

public sealed class FakeClock(DateOnly today) : IClock
{
    public DateOnly Today { get; } = today;
}
```

`tests/ReCharacter.RulesEngine.Tests/DischargeRouterTests.cs`:

```csharp
using ReCharacter.RulesEngine;
using Xunit;

namespace ReCharacter.RulesEngine.Tests;

public class DischargeRouterTests
{
    private static DischargeRouter RouterAt(int year, int month, int day) =>
        new(new FakeClock(new DateOnly(year, month, day)));

    [Fact]
    public void Route_MarineOthAdminSep_WithinWindow_RecommendsDrbWithDd293()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.MarineCorps,
            DischargeDate = new DateOnly(2024, 6, 1),
            Characterization = DischargeCharacterization.OtherThanHonorable,
            WasGeneralCourtMartial = false
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal(ReviewBoard.Drb, result.RecommendedBoard);
        Assert.Equal(ApplicationForm.DD293, result.RecommendedForm);
        Assert.Equal("NDRB", result.BoardName);
        Assert.True(result.DrbWindowOpen);
        Assert.Equal(new DateOnly(2039, 6, 1), result.DrbDeadline);
        Assert.Equal(new[] { ReviewBoard.Drb, ReviewBoard.Bcmr }, result.AvailableBoards);
        Assert.Empty(result.Flags);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/ReCharacter.RulesEngine.Tests --filter DischargeRouterTests`
Expected: FAIL — compile error, `ReviewBoard`, `ApplicationForm`, `DischargeFacts`, `RoutingResult`, `IClock`, `DischargeRouter` do not exist.

- [ ] **Step 3: Write minimal implementation**

`src/ReCharacter.RulesEngine/RoutingTypes.cs`:

```csharp
namespace ReCharacter.RulesEngine;

public enum ReviewBoard { Drb, Bcmr }

public enum ApplicationForm { DD293, DD149 }

public enum RoutingFlag
{
    PastDrbWindow,
    GeneralCourtMartialRequiresBcmr,
    CoastGuardDhsPolicyDiffers,
    BcmrThreeYearStatuteWaiverLikely,
    EntryLevelSeparationUncharacterized,
    AlreadyHonorableNothingToUpgrade
}
```

`src/ReCharacter.RulesEngine/DischargeFacts.cs`:

```csharp
namespace ReCharacter.RulesEngine;

public sealed record DischargeFacts
{
    public required Branch Branch { get; init; }
    public required DateOnly DischargeDate { get; init; }
    public required DischargeCharacterization Characterization { get; init; }
    public bool WasGeneralCourtMartial { get; init; }
}
```

`src/ReCharacter.RulesEngine/RoutingResult.cs`:

```csharp
namespace ReCharacter.RulesEngine;

public sealed record RoutingResult
{
    public required ReviewBoard RecommendedBoard { get; init; }
    public required ApplicationForm RecommendedForm { get; init; }
    public required string BoardName { get; init; }
    public required IReadOnlyList<ReviewBoard> AvailableBoards { get; init; }
    public required DateOnly DrbDeadline { get; init; }
    public required bool DrbWindowOpen { get; init; }
    public required IReadOnlyList<RoutingFlag> Flags { get; init; }
}
```

`src/ReCharacter.RulesEngine/IClock.cs`:

```csharp
namespace ReCharacter.RulesEngine;

public interface IClock
{
    DateOnly Today { get; }
}

public sealed class SystemClock : IClock
{
    public DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);
}
```

`src/ReCharacter.RulesEngine/DischargeRouter.cs`:

```csharp
namespace ReCharacter.RulesEngine;

public sealed class DischargeRouter(IClock clock)
{
    public RoutingResult Route(DischargeFacts facts)
    {
        if (facts.DischargeDate > clock.Today)
            throw new ArgumentException("Discharge date cannot be in the future.", nameof(facts));

        var names = BoardDirectory.For(facts.Branch);
        var deadline = DrbWindow.Deadline(facts.DischargeDate);
        var drbOpen = DrbWindow.IsOpen(facts.DischargeDate, clock.Today);
        var flags = new List<RoutingFlag>();

        // The DRB cannot review general-court-martial discharges; the BCMR must.
        var mustUseBcmr = facts.WasGeneralCourtMartial || !drbOpen;

        if (facts.WasGeneralCourtMartial)
            flags.Add(RoutingFlag.GeneralCourtMartialRequiresBcmr);
        else if (!drbOpen)
            flags.Add(RoutingFlag.PastDrbWindow);

        if (mustUseBcmr)
            flags.Add(RoutingFlag.BcmrThreeYearStatuteWaiverLikely);

        if (facts.Branch == Branch.CoastGuard)
            flags.Add(RoutingFlag.CoastGuardDhsPolicyDiffers);

        if (facts.Characterization == DischargeCharacterization.Uncharacterized)
            flags.Add(RoutingFlag.EntryLevelSeparationUncharacterized);

        if (facts.Characterization == DischargeCharacterization.Honorable)
            flags.Add(RoutingFlag.AlreadyHonorableNothingToUpgrade);

        var board = mustUseBcmr ? ReviewBoard.Bcmr : ReviewBoard.Drb;
        var form = board == ReviewBoard.Drb ? ApplicationForm.DD293 : ApplicationForm.DD149;
        var boardName = board == ReviewBoard.Drb ? names.DrbName : names.BcmrName;

        var available = new List<ReviewBoard>();
        if (drbOpen && !facts.WasGeneralCourtMartial)
            available.Add(ReviewBoard.Drb);
        available.Add(ReviewBoard.Bcmr);

        return new RoutingResult
        {
            RecommendedBoard = board,
            RecommendedForm = form,
            BoardName = boardName,
            AvailableBoards = available,
            DrbDeadline = deadline,
            DrbWindowOpen = drbOpen,
            Flags = flags
        };
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/ReCharacter.RulesEngine.Tests --filter DischargeRouterTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ReCharacter.RulesEngine/RoutingTypes.cs src/ReCharacter.RulesEngine/DischargeFacts.cs src/ReCharacter.RulesEngine/RoutingResult.cs src/ReCharacter.RulesEngine/IClock.cs src/ReCharacter.RulesEngine/DischargeRouter.cs tests/ReCharacter.RulesEngine.Tests/FakeClock.cs tests/ReCharacter.RulesEngine.Tests/DischargeRouterTests.cs
git commit -m "feat: add discharge router happy path (within-window admin separation)"
```

---

## Task 4: Router — past the DRB window routes to BCMR

**Files:**
- Modify: `tests/ReCharacter.RulesEngine.Tests/DischargeRouterTests.cs` (add test)

- [ ] **Step 1: Write the failing test**

Add to `DischargeRouterTests`:

```csharp
    [Fact]
    public void Route_MarineOth_PastFifteenYears_RecommendsBcmrWithDd149()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.MarineCorps,
            DischargeDate = new DateOnly(2009, 1, 1),
            Characterization = DischargeCharacterization.OtherThanHonorable,
            WasGeneralCourtMartial = false
        };

        var result = RouterAt(2026, 7, 5).Route(facts); // > 15 years later

        Assert.Equal(ReviewBoard.Bcmr, result.RecommendedBoard);
        Assert.Equal(ApplicationForm.DD149, result.RecommendedForm);
        Assert.Equal("BCNR", result.BoardName);
        Assert.False(result.DrbWindowOpen);
        Assert.Equal(new[] { ReviewBoard.Bcmr }, result.AvailableBoards);
        Assert.Contains(RoutingFlag.PastDrbWindow, result.Flags);
        Assert.Contains(RoutingFlag.BcmrThreeYearStatuteWaiverLikely, result.Flags);
    }
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `dotnet test tests/ReCharacter.RulesEngine.Tests --filter DischargeRouterTests`
Expected: PASS (the Task 3 implementation already handles this). If it fails, fix `DischargeRouter` before proceeding — do not edit the test to match a wrong result.

- [ ] **Step 3: Commit**

```bash
git add tests/ReCharacter.RulesEngine.Tests/DischargeRouterTests.cs
git commit -m "test: cover past-DRB-window routing to BCMR"
```

---

## Task 5: Router — general court-martial forces BCMR even within 15 years

**Files:**
- Modify: `tests/ReCharacter.RulesEngine.Tests/DischargeRouterTests.cs` (add test)

- [ ] **Step 1: Write the failing test**

Add to `DischargeRouterTests`:

```csharp
    [Fact]
    public void Route_GeneralCourtMartial_WithinWindow_StillRoutesToBcmr()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.Army,
            DischargeDate = new DateOnly(2023, 5, 1), // well within 15 years
            Characterization = DischargeCharacterization.BadConductDischarge,
            WasGeneralCourtMartial = true
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal(ReviewBoard.Bcmr, result.RecommendedBoard);
        Assert.Equal(ApplicationForm.DD149, result.RecommendedForm);
        Assert.Equal("ABCMR", result.BoardName);
        Assert.Contains(RoutingFlag.GeneralCourtMartialRequiresBcmr, result.Flags);
        Assert.DoesNotContain(ReviewBoard.Drb, result.AvailableBoards);
        // DRB window is technically open, even though DRB is unavailable for GCM.
        Assert.True(result.DrbWindowOpen);
    }
```

- [ ] **Step 2: Run test to verify it passes**

Run: `dotnet test tests/ReCharacter.RulesEngine.Tests --filter DischargeRouterTests`
Expected: PASS (Task 3 implementation handles GCM). If it fails, fix `DischargeRouter`, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/ReCharacter.RulesEngine.Tests/DischargeRouterTests.cs
git commit -m "test: general court-martial routes to BCMR within window"
```

---

## Task 6: Router — advisory flags and the future-date guard

**Files:**
- Modify: `tests/ReCharacter.RulesEngine.Tests/DischargeRouterTests.cs` (add tests)

- [ ] **Step 1: Write the failing tests**

Add to `DischargeRouterTests`:

```csharp
    [Fact]
    public void Route_CoastGuard_AddsDhsPolicyFlag()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.CoastGuard,
            DischargeDate = new DateOnly(2022, 2, 2),
            Characterization = DischargeCharacterization.GeneralUnderHonorable
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal("CGDRB", result.BoardName);
        Assert.Contains(RoutingFlag.CoastGuardDhsPolicyDiffers, result.Flags);
    }

    [Fact]
    public void Route_Uncharacterized_AddsEntryLevelFlag()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.Navy,
            DischargeDate = new DateOnly(2023, 9, 9),
            Characterization = DischargeCharacterization.Uncharacterized
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Contains(RoutingFlag.EntryLevelSeparationUncharacterized, result.Flags);
    }

    [Fact]
    public void Route_AlreadyHonorable_AddsNothingToUpgradeFlag()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.AirForce,
            DischargeDate = new DateOnly(2023, 9, 9),
            Characterization = DischargeCharacterization.Honorable
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Contains(RoutingFlag.AlreadyHonorableNothingToUpgrade, result.Flags);
    }

    [Fact]
    public void Route_FutureDischargeDate_Throws()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.Army,
            DischargeDate = new DateOnly(2027, 1, 1),
            Characterization = DischargeCharacterization.OtherThanHonorable
        };

        Assert.Throws<ArgumentException>(() => RouterAt(2026, 7, 5).Route(facts));
    }
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `dotnet test tests/ReCharacter.RulesEngine.Tests --filter DischargeRouterTests`
Expected: PASS — all router tests green. If any fail, fix `DischargeRouter`, not the tests.

- [ ] **Step 3: Run the full library test suite**

Run: `dotnet test tests/ReCharacter.RulesEngine.Tests`
Expected: PASS — BoardDirectory, DrbWindow, and DischargeRouter suites all green.

- [ ] **Step 4: Commit**

```bash
git add tests/ReCharacter.RulesEngine.Tests/DischargeRouterTests.cs
git commit -m "test: cover advisory flags and future-date guard"
```

---

## Task 7: Routing API — `POST /route`

**Files:**
- Modify: `src/ReCharacter.RoutingApi/Program.cs` (replace template contents)
- Test: `tests/ReCharacter.RoutingApi.Tests/RouteEndpointTests.cs`

- [ ] **Step 1: Write the failing integration test**

`tests/ReCharacter.RoutingApi.Tests/RouteEndpointTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace ReCharacter.RoutingApi.Tests;

public class RouteEndpointTests(WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Post_Route_MarineOthWithinWindow_ReturnsDrbDd293()
    {
        var client = factory.CreateClient();

        var body = new
        {
            branch = "MarineCorps",
            dischargeDate = "2024-06-01",
            characterization = "OtherThanHonorable",
            wasGeneralCourtMartial = false
        };

        var response = await client.PostAsJsonAsync("/route", body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("Drb", root.GetProperty("recommendedBoard").GetString());
        Assert.Equal("DD293", root.GetProperty("recommendedForm").GetString());
        Assert.Equal("NDRB", root.GetProperty("boardName").GetString());
        Assert.True(root.GetProperty("drbWindowOpen").GetBoolean());
    }

    [Fact]
    public async Task Post_Route_FutureDischargeDate_ReturnsBadRequest()
    {
        var client = factory.CreateClient();

        var body = new
        {
            branch = "Army",
            dischargeDate = "2099-01-01",
            characterization = "OtherThanHonorable",
            wasGeneralCourtMartial = false
        };

        var response = await client.PostAsJsonAsync("/route", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/ReCharacter.RoutingApi.Tests`
Expected: FAIL — the template API has no `/route` endpoint (404), and `Program` is not yet public/partial for `WebApplicationFactory`.

- [ ] **Step 3: Replace `Program.cs` with the minimal API**

`src/ReCharacter.RoutingApi/Program.cs` (replace entire file):

```csharp
using System.Text.Json.Serialization;
using ReCharacter.RulesEngine;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<IClock, SystemClock>();
builder.Services.AddScoped<DischargeRouter>();
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));

var app = builder.Build();

app.MapPost("/route", (DischargeFacts facts, DischargeRouter router) =>
{
    try
    {
        return Results.Ok(router.Route(facts));
    }
    catch (ArgumentException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.Run();

// Exposed so the integration test's WebApplicationFactory<Program> can boot the app.
public partial class Program { }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/ReCharacter.RoutingApi.Tests`
Expected: PASS — both endpoint cases green.

- [ ] **Step 5: Run the entire solution's tests**

Run: `dotnet test`
Expected: PASS — every project's tests green.

- [ ] **Step 6: Commit**

```bash
git add src/ReCharacter.RoutingApi/Program.cs tests/ReCharacter.RoutingApi.Tests/RouteEndpointTests.cs
git commit -m "feat: expose POST /route routing endpoint"
```

---

## Definition of done (Plan 01)

- `dotnet test` is green across all four projects.
- `POST /route` returns the correct board, form, board name, deadline, availability, and flags for: within-window admin separation, past-window, general court-martial, Coast Guard, uncharacterized, and already-honorable cases.
- The 15-year DRB boundary is covered by explicit day-before / day-of / day-after tests.
- No `DateTime.Now`/`DateTime.Today` anywhere in `ReCharacter.RulesEngine` except the single centralized `SystemClock`.
