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
