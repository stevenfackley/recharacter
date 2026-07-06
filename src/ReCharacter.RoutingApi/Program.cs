using System.Text.Json.Serialization;
using ReCharacter.RulesEngine;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<IClock, SystemClock>();
builder.Services.AddSingleton<DischargeRouter>(); // stateless; no per-request state to isolate
builder.Services.AddProblemDetails();
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
        // Domain guard (e.g. future discharge date). Emit RFC 7807 problem+json so this matches
        // the shape ASP.NET already returns for model-binding failures (bad JSON, missing required
        // field, unparseable date/enum) — one predictable 400 body for the Next.js consumer.
        return Results.Problem(detail: ex.Message, statusCode: StatusCodes.Status400BadRequest);
    }
});

app.Run();

// Exposed so the integration test's WebApplicationFactory<Program> can boot the app.
public partial class Program { }
