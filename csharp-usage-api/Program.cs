using EatNow.UsageApi.Services;
using Microsoft.Extensions.Caching.Memory;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(p => p.AddDefaultPolicy(x => x
  .AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

builder.Services.AddMemoryCache();
builder.Services.AddSingleton<FirestoreService>();
builder.Services.AddControllers();
var app = builder.Build();

app.UseCors();
app.MapControllers();
app.MapGet("/", () => new { ok = true, name = "EatNow Usage API", version = "v1" });
app.Run();
